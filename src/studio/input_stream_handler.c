#include <pb_decode.h>
#include <pb_encode.h>
#include <string.h>
#include <stdio.h>
#include <zmk/studio/custom.h>
#include <zmk/input_stream/input_stream.pb.h>
#include <zmk/workqueue.h>
#include <zmk/studio/core.h>

#include <zmk/events/position_state_changed.h>
#include <zmk/events/layer_state_changed.h>
#include <zmk/events/endpoint_changed.h>
#include <zmk/keymap.h>
#include <zmk/behavior.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#ifndef CONFIG_ZMK_INPUT_STREAM_FORK_LOG_LEVEL
#define CONFIG_ZMK_INPUT_STREAM_FORK_LOG_LEVEL 3
#endif
LOG_MODULE_REGISTER(zmk_input_stream_fork_input_stream_handler,
                    CONFIG_ZMK_INPUT_STREAM_FORK_LOG_LEVEL);

/* This lock protects lifecycle and queue operations, never transport I/O. */
static struct k_spinlock notif_lock;
static bool streaming_enabled;
static uint32_t stream_epoch;
static int64_t stream_lease_deadline;
static uint32_t notifications_queued, notifications_dropped;

static struct zmk_rpc_custom_subsystem_meta input_stream_meta = {
    ZMK_RPC_CUSTOM_SUBSYSTEM_UI_URLS("https://cormoran.github.io/zmk-feature-input-stream/"),
    .security = ZMK_STUDIO_RPC_HANDLER_SECURED,
};

ZMK_RPC_CUSTOM_SUBSYSTEM(zmk__input_stream, &input_stream_meta, input_stream_rpc_handle_request);

ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER(zmk__input_stream, zmk_input_stream_Response);

static int get_own_subsystem_index(void) {
    /* The linker registry is fixed for this boot. Only the serialized sender
     * work calls here, so a successful lookup needs neither another scan nor
     * a lifecycle lock. Failed lookups remain retryable. */
    static int cached_index = -1;
    if (cached_index >= 0) {
        return cached_index;
    }
    size_t count;
    STRUCT_SECTION_COUNT(zmk_rpc_custom_subsystem, &count);
    for (size_t i = 0; i < count; i++) {
        struct zmk_rpc_custom_subsystem *s;
        STRUCT_SECTION_GET(zmk_rpc_custom_subsystem, i, &s);
        if (strcmp(s->identifier, "zmk__input_stream") == 0) {
            cached_index = (int)i;
            return cached_index;
        }
    }
    return -1;
}

/* ── Direct notification send (called only from the low-priority work handler) ── */

struct queued_notification {
    zmk_input_stream_Notification payload;
    uint32_t epoch;
};

struct notification_encoding {
    struct queued_notification item;
    bool decided;
    bool allowed;
};
static struct notification_encoding s_notification;

static bool stream_epoch_is_current(uint32_t epoch) {
    k_spinlock_key_t key = k_spin_lock(&notif_lock);
    bool current = streaming_enabled && epoch == stream_epoch &&
                   stream_lease_deadline > k_uptime_get() &&
                   zmk_studio_core_get_lock_state() == ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED;
    k_spin_unlock(&notif_lock, key);
    return current;
}

static bool encode_notification_payload(pb_ostream_t *stream, const pb_field_t *field,
                                        void *const *arg) {
    struct notification_encoding *notif = *arg;
    /* The first encoder pass starts after the transport mutex wait. Nanopb
     * sizes nested messages before writing them: keep one decision for all
     * passes so revocation cannot leave an unterminated Studio frame. */
    if (!notif->decided) {
        notif->allowed = stream_epoch_is_current(notif->item.epoch);
        notif->decided = true;
    }
    if (!notif->allowed) {
        return true; /* omit the bytes field; the enclosing frame stays valid */
    }
    return zmk_rpc_custom_subsystem_encode_response_payload(
        stream, field, zmk_input_stream_Notification_fields, &notif->item.payload);
}

static void send_notification_direct(const struct queued_notification *notif) {
    if (!stream_epoch_is_current(notif->epoch)) {
        return;
    }
    int idx = get_own_subsystem_index();
    if (idx < 0) {
        LOG_ERR("input_stream subsystem not found");
        return;
    }
    s_notification = (struct notification_encoding){.item = *notif};
    struct zmk_studio_custom_notification custom_notif = {
        .subsystem_index = (uint8_t)idx,
        .encode_payload =
            {
                .funcs.encode = encode_notification_payload,
                .arg = &s_notification,
            },
    };
    raise_zmk_studio_custom_notification(custom_notif);
}

/* ── Notification queue + low-priority sender ──────────────────────────── */

/* Fixed-capacity message queue. Alignment 4 matches ZMK's behavior_queue.c pattern. */
K_MSGQ_DEFINE(notif_queue, sizeof(struct queued_notification),
              CONFIG_ZMK_INPUT_STREAM_NOTIF_QUEUE_SIZE, 4);

static void notif_send_work_handler(struct k_work *work);
static K_WORK_DEFINE(notif_send_work, notif_send_work_handler);

/* Caller owns notif_lock. Epoch zero is reserved for missing renewal tokens. */
static void advance_stream_epoch_locked(void) {
    stream_epoch++;
    if (stream_epoch == 0)
        stream_epoch = 1;
}

static void retire_stream_locked(void) {
    advance_stream_epoch_locked();
    streaming_enabled = false;
    stream_lease_deadline = 0;
    k_msgq_purge(&notif_queue);
}

static void stream_lease_expired(struct k_timer *timer) {
    ARG_UNUSED(timer);
    k_spinlock_key_t key = k_spin_lock(&notif_lock);
    if (streaming_enabled && stream_lease_deadline <= k_uptime_get()) {
        retire_stream_locked();
    }
    k_spin_unlock(&notif_lock, key);
}

static K_TIMER_DEFINE(stream_lease_timer, stream_lease_expired, NULL);

static void renew_stream_lease_locked(void) {
    stream_lease_deadline = k_uptime_get() + CONFIG_ZMK_INPUT_STREAM_LEASE_MS;
    k_timer_start(&stream_lease_timer, K_MSEC(CONFIG_ZMK_INPUT_STREAM_LEASE_MS), K_NO_WAIT);
}

static bool capture_stream_epoch(uint32_t *epoch) {
    k_spinlock_key_t key = k_spin_lock(&notif_lock);
    bool enabled = streaming_enabled && stream_lease_deadline > k_uptime_get() &&
                   zmk_studio_core_get_lock_state() == ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED;
    *epoch = stream_epoch;
    k_spin_unlock(&notif_lock, key);
    return enabled;
}

static bool set_stream_enabled(bool enabled) {
    k_spinlock_key_t key = k_spin_lock(&notif_lock);
    if (enabled && zmk_studio_core_get_lock_state() != ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED) {
        k_spin_unlock(&notif_lock, key);
        return false;
    }
    if (streaming_enabled && stream_lease_deadline <= k_uptime_get()) {
        retire_stream_locked();
    }
    const bool changed = streaming_enabled != enabled;
    if (changed) {
        advance_stream_epoch_locked();
        streaming_enabled = enabled;
        k_msgq_purge(&notif_queue);
    }
    if (enabled) {
        renew_stream_lease_locked();
    } else {
        stream_lease_deadline = 0;
    }
    const uint32_t epoch = stream_epoch;
    const uint32_t queued = notifications_queued;
    const uint32_t dropped = notifications_dropped;
    k_spin_unlock(&notif_lock, key);
    if (changed) {
        LOG_INF("stream enabled=%d epoch=%u queued=%u dropped=%u", enabled, epoch, queued, dropped);
    }
    return true;
}

static bool renew_stream(uint32_t epoch) {
    k_spinlock_key_t key = k_spin_lock(&notif_lock);
    bool current = epoch != 0 && epoch == stream_epoch && streaming_enabled &&
                   stream_lease_deadline > k_uptime_get() &&
                   zmk_studio_core_get_lock_state() == ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED;
    if (current)
        renew_stream_lease_locked();
    k_spin_unlock(&notif_lock, key);
    return current;
}

static void notif_send_work_handler(struct k_work *work) {
    ARG_UNUSED(work);
    struct queued_notification item;
    k_spinlock_key_t key = k_spin_lock(&notif_lock);
    bool send = streaming_enabled && stream_lease_deadline > k_uptime_get() &&
                k_msgq_get(&notif_queue, &item, K_NO_WAIT) == 0;
    if (send) {
        send = item.epoch == stream_epoch;
    }
    k_spin_unlock(&notif_lock, key);

    /* One dispatch per invocation gives already queued work a turn. A selected
     * dispatch can still block or finish after a disable request. */
    if (send) {
        send_notification_direct(&item);
    }

    key = k_spin_lock(&notif_lock);
    bool more = streaming_enabled && stream_lease_deadline > k_uptime_get() &&
                k_msgq_num_used_get(&notif_queue) > 0;
    k_spin_unlock(&notif_lock, key);
    if (more) {
        k_work_submit_to_queue(zmk_workqueue_lowprio_work_q(), &notif_send_work);
    }
}

/**
 * Enqueue a notification for low-priority delivery.
 * Called from event handlers; returns immediately so the event thread is not stalled.
 * Drops silently if the queue is full (limit = CONFIG_ZMK_INPUT_STREAM_NOTIF_QUEUE_SIZE).
 */
static void enqueue_notification(const zmk_input_stream_Notification *notif, uint32_t epoch) {
    struct queued_notification item = {.payload = *notif, .epoch = epoch};
    k_spinlock_key_t key = k_spin_lock(&notif_lock);
    bool queued = streaming_enabled && epoch == stream_epoch &&
                  stream_lease_deadline > k_uptime_get() &&
                  k_msgq_put(&notif_queue, &item, K_NO_WAIT) == 0;
    if (queued) {
        notifications_queued++;
    } else if (streaming_enabled && epoch == stream_epoch) {
        notifications_dropped++;
    }
    k_spin_unlock(&notif_lock, key);
    if (queued) {
        k_work_submit_to_queue(zmk_workqueue_lowprio_work_q(), &notif_send_work);
    }
}

/* ── RPC handler ───────────────────────────────────────────────────────── */

static void fill_layer_state(zmk_input_stream_LayerChangeNotification *out) {
    out->layer_index = zmk_keymap_highest_layer_active();
    out->active_layer_mask = 0;
    out->active_layer_mask_valid = false;
    /* The selected core's layer state is uint32. Mapping each index through
     * the public API preserves reordered stable IDs and removed-layer slots. */
    zmk_keymap_layers_state_t state = zmk_keymap_layer_state();
    zmk_keymap_layer_id_t default_id = zmk_keymap_layer_default();
    if (default_id >= 32)
        return;
    zmk_keymap_layer_id_t ids[32];
    uint32_t default_index = 32;
    for (uint32_t index = 0; index < ARRAY_SIZE(ids); index++) {
        ids[index] = zmk_keymap_layer_index_to_id(index);
        if (ids[index] == default_id)
            default_index = index;
    }
    if (default_index == 32 || out->layer_index >= 32)
        return;
    for (uint32_t index = default_index; index < ARRAY_SIZE(ids); index++) {
        if (ids[index] < 32 && ((state & BIT(ids[index])) || ids[index] == default_id)) {
            out->active_layer_mask |= BIT(index);
        }
    }
    /* A concurrent core edit can invalidate this observational snapshot.
     * Report unknown fallback rather than claiming an inconsistent mask. */
    out->active_layer_mask_valid =
        (out->active_layer_mask & BIT(out->layer_index)) &&
        (out->layer_index == 31 || (out->active_layer_mask >> (out->layer_index + 1)) == 0);
}

static void fill_ok_response(zmk_input_stream_OkResponse *out) {
    out->has_layer_state = true;
    fill_layer_state(&out->layer_state);
    k_spinlock_key_t key = k_spin_lock(&notif_lock);
    out->stream_epoch =
        streaming_enabled && stream_lease_deadline > k_uptime_get() ? stream_epoch : 0;
    out->lease_ms = CONFIG_ZMK_INPUT_STREAM_LEASE_MS;
    k_spin_unlock(&notif_lock, key);
}

static bool input_stream_rpc_handle_request(const zmk_custom_CallRequest *raw_request,
                                            pb_callback_t *encode_response) {
    zmk_input_stream_Response *resp =
        ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER_ALLOCATE(zmk__input_stream, encode_response);

    zmk_input_stream_Request req = zmk_input_stream_Request_init_zero;
    pb_istream_t req_stream =
        pb_istream_from_buffer(raw_request->payload.bytes, raw_request->payload.size);
    if (!pb_decode(&req_stream, zmk_input_stream_Request_fields, &req)) {
        LOG_WRN("Failed to decode input_stream request: %s", PB_GET_ERROR(&req_stream));
        zmk_input_stream_ErrorResponse err = zmk_input_stream_ErrorResponse_init_zero;
        snprintf(err.message, sizeof(err.message), "Failed to decode request");
        resp->which_response_type = zmk_input_stream_Response_error_tag;
        resp->response_type.error = err;
        return true;
    }

    switch (req.which_request_type) {
    case zmk_input_stream_Request_enable_stream_tag:
        if (!(req.request_type.enable_stream.renew_only
                  ? renew_stream(req.request_type.enable_stream.stream_epoch)
                  : set_stream_enabled(true))) {
            resp->which_response_type = zmk_input_stream_Response_error_tag;
            snprintf(resp->response_type.error.message, sizeof(resp->response_type.error.message),
                     "Stream locked, expired or changed; enable explicitly");
            break;
        }
        resp->which_response_type = zmk_input_stream_Response_ok_tag;
        break;
    case zmk_input_stream_Request_disable_stream_tag:
        set_stream_enabled(false);
        resp->which_response_type = zmk_input_stream_Response_ok_tag;
        break;
    default:
        LOG_WRN("Unsupported input_stream request type: %d", req.which_request_type);
        {
            zmk_input_stream_ErrorResponse err = zmk_input_stream_ErrorResponse_init_zero;
            snprintf(err.message, sizeof(err.message), "Unknown request type");
            resp->which_response_type = zmk_input_stream_Response_error_tag;
            resp->response_type.error = err;
        }
        break;
    }
    if (resp->which_response_type == zmk_input_stream_Response_ok_tag) {
        fill_ok_response(&resp->response_type.ok);
    }
    return true;
}

static int on_position_state_changed(const zmk_event_t *eh) {
    uint32_t epoch;
    if (!capture_stream_epoch(&epoch)) {
        return ZMK_EV_EVENT_BUBBLE;
    }
    const struct zmk_position_state_changed *ev = as_zmk_position_state_changed(eh);
    if (!ev) {
        return ZMK_EV_EVENT_BUBBLE;
    }

    zmk_keymap_layer_index_t layer_idx = zmk_keymap_highest_layer_active();
    zmk_keymap_layer_id_t layer_id = zmk_keymap_layer_index_to_id(layer_idx);
    const struct zmk_behavior_binding *binding =
        zmk_keymap_get_layer_binding_at_idx(layer_id, ev->position);

    zmk_input_stream_Notification notif = zmk_input_stream_Notification_init_zero;
    notif.which_notification_type = zmk_input_stream_Notification_key_event_tag;
    notif.notification_type.key_event.position = ev->position;
    notif.notification_type.key_event.pressed = ev->state;
    if (binding != NULL) {
#if IS_ENABLED(CONFIG_ZMK_BEHAVIOR_LOCAL_IDS)
        notif.notification_type.key_event.behavior_id =
            zmk_behavior_get_local_id(binding->behavior_dev);
#endif
        notif.notification_type.key_event.param1 = binding->param1;
        notif.notification_type.key_event.param2 = binding->param2;
    }

    enqueue_notification(&notif, epoch);
    return ZMK_EV_EVENT_BUBBLE;
}

ZMK_LISTENER(input_stream_position, on_position_state_changed);
ZMK_SUBSCRIPTION(input_stream_position, zmk_position_state_changed);

static int on_layer_state_changed(const zmk_event_t *eh) {
    uint32_t epoch;
    if (!capture_stream_epoch(&epoch)) {
        return ZMK_EV_EVENT_BUBBLE;
    }

    zmk_input_stream_Notification notif = zmk_input_stream_Notification_init_zero;
    notif.which_notification_type = zmk_input_stream_Notification_layer_change_tag;
    fill_layer_state(&notif.notification_type.layer_change);

    enqueue_notification(&notif, epoch);
    return ZMK_EV_EVENT_BUBBLE;
}

ZMK_LISTENER(input_stream_layer, on_layer_state_changed);
ZMK_SUBSCRIPTION(input_stream_layer, zmk_layer_state_changed);

/* Secured RPC registration gates requests, not asynchronous notifications.
 * Revoke the local stream on a lock or output change without waiting for work
 * or transport I/O. Unlocking alone never restores a previous stream. */
static int on_stream_authorization_changed(const zmk_event_t *eh) {
    const struct zmk_studio_core_lock_state_changed *lock =
        as_zmk_studio_core_lock_state_changed(eh);
    if (as_zmk_endpoint_changed(eh) ||
        (lock && lock->state != ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED)) {
        set_stream_enabled(false);
    }
    return ZMK_EV_EVENT_BUBBLE;
}

ZMK_LISTENER(input_stream_authorization, on_stream_authorization_changed);
ZMK_SUBSCRIPTION(input_stream_authorization, zmk_studio_core_lock_state_changed);
ZMK_SUBSCRIPTION(input_stream_authorization, zmk_endpoint_changed);
