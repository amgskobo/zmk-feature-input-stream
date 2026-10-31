/* SPDX-License-Identifier: MIT */
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <pb_decode.h>
#include <pb_encode.h>
#include <envelope.pb.h>
#include <stdlib.h>
#include <string.h>
#include <zmk/studio/custom.h>
#include <zmk/events/position_state_changed.h>
#include <zmk/events/layer_state_changed.h>
#include <zmk/keymap.h>
#include <zmk/behavior.h>
#include <zmk/workqueue.h>
#include <zmk/studio/core.h>
#include <zmk/events/endpoint_changed.h>

#define CHECK(x)                                                                                   \
    do {                                                                                           \
        if (!(x)) {                                                                                \
            printk("FAIL line=%d: %s\n", __LINE__, #x);                                            \
            exit(1);                                                                               \
        }                                                                                          \
    } while (0)
struct zmk_rpc_custom_subsystem test_subsystems[2] = {{"other"}, {"zmk__input_stream"}};
size_t test_subsystem_count = 2;
unsigned test_subsystem_lookups;
static uint8_t layer_index;
static const struct zmk_behavior_binding binding = {
    .behavior_dev = "test", .param1 = UINT32_MAX, .param2 = 17};
static bool binding_gate;
static enum zmk_studio_core_lock_state studio_state = ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED;
enum zmk_studio_core_lock_state zmk_studio_core_get_lock_state(void) { return studio_state; }
ZMK_EVENT_IMPL(zmk_studio_core_lock_state_changed);
ZMK_EVENT_IMPL(zmk_endpoint_changed);
static void studio(bool unlocked) {
    studio_state =
        unlocked ? ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED : ZMK_STUDIO_CORE_LOCK_STATE_LOCKED;
    CHECK(raise_zmk_studio_core_lock_state_changed(
              (struct zmk_studio_core_lock_state_changed){.state = studio_state}) == 0);
}
K_SEM_DEFINE(binding_entered, 0, 1);
K_SEM_DEFINE(binding_release, 0, 1);
zmk_keymap_layer_index_t zmk_keymap_highest_layer_active(void) { return layer_index; }
zmk_keymap_layer_id_t zmk_keymap_layer_index_to_id(zmk_keymap_layer_index_t idx) {
    CHECK(idx == layer_index);
    return 7;
}
const struct zmk_behavior_binding *zmk_keymap_get_layer_binding_at_idx(zmk_keymap_layer_id_t id,
                                                                       uint16_t pos) {
    CHECK(id == 7);
    if (binding_gate) {
        k_sem_give(&binding_entered);
        CHECK(k_sem_take(&binding_release, K_MSEC(500)) == 0);
    }
    return pos == 15 ? NULL : &binding;
}
uint16_t zmk_behavior_get_local_id(const char *name) {
    CHECK(!strcmp(name, "test"));
    return 42;
}

bool zmk_rpc_custom_subsystem_encode_response_payload(pb_ostream_t *s, const pb_field_t *f,
                                                      const pb_msgdesc_t *fields,
                                                      const void *value) {
    size_t size;
    return pb_encode_tag_for_field(s, f) && pb_get_encoded_size(&size, fields, value) &&
           pb_encode_varint(s, size) && pb_encode(s, fields, value);
}
static bool encode_response(pb_ostream_t *s, const pb_field_t *f, void *const *arg) {
    return zmk_rpc_custom_subsystem_encode_response_payload(s, f, zmk_input_stream_Response_fields,
                                                            *arg);
}
static zmk_input_stream_Response response;
zmk_input_stream_Response *test_allocate_response(pb_callback_t *cb) {
    response = (zmk_input_stream_Response)zmk_input_stream_Response_init_zero;
    cb->funcs.encode = encode_response;
    cb->arg = &response;
    return &response;
}
static bool lock_after_sizing;
struct payload_capture {
    uint8_t bytes[128];
    size_t size;
};
static bool capture_payload(pb_istream_t *stream, const pb_field_t *field, void **arg) {
    ARG_UNUSED(field);
    struct payload_capture *capture = *arg;
    capture->size = stream->bytes_left;
    return capture->size <= sizeof(capture->bytes) &&
           pb_read(stream, capture->bytes, capture->size);
}
static bool try_decode_callback(pb_callback_t cb, const pb_msgdesc_t *fields, void *value) {
    uint8_t bytes[128];
    sender_fixture_Envelope envelope = sender_fixture_Envelope_init_zero;
    envelope.has_payload = true;
    envelope.payload.body = cb;
    size_t size;
    CHECK(pb_get_encoded_size(&size, sender_fixture_Envelope_fields, &envelope));
    if (lock_after_sizing) {
        lock_after_sizing = false;
        studio(false);
    }
    pb_ostream_t stream = pb_ostream_from_buffer(bytes, sizeof(bytes));
    CHECK(pb_encode(&stream, sender_fixture_Envelope_fields, &envelope));
    CHECK(stream.bytes_written == size);
    pb_istream_t input = pb_istream_from_buffer(bytes, stream.bytes_written);
    struct payload_capture capture = {0};
    sender_fixture_Envelope decoded = sender_fixture_Envelope_init_zero;
    decoded.payload.body.funcs.decode = capture_payload;
    decoded.payload.body.arg = &capture;
    CHECK(pb_decode(&input, sender_fixture_Envelope_fields, &decoded));
    CHECK(input.bytes_left == 0);
    if (capture.size == 0) {
        return false;
    }
    input = pb_istream_from_buffer(capture.bytes, capture.size);
    CHECK(pb_decode(&input, fields, value) && input.bytes_left == 0);
    return true;
}
static void decode_callback(pb_callback_t cb, const pb_msgdesc_t *fields, void *value) {
    CHECK(try_decode_callback(cb, fields, value));
}

static zmk_input_stream_Notification sent[32];
static unsigned sent_count, rejected_count, order[40], order_count;
static bool send_gate;
K_SEM_DEFINE(send_entered, 0, 1);
K_SEM_DEFINE(send_release, 0, 1);
static int receive_notification(const zmk_event_t *eh) {
    struct zmk_studio_custom_notification *ev = as_zmk_studio_custom_notification(eh);
    CHECK(ev && ev->subsystem_index == 1 && sent_count < ARRAY_SIZE(sent));
    if (send_gate) {
        send_gate = false;
        k_sem_give(&send_entered);
        CHECK(k_sem_take(&send_release, K_MSEC(500)) == 0);
    }
    sent[sent_count] = (zmk_input_stream_Notification)zmk_input_stream_Notification_init_zero;
    if (!try_decode_callback(ev->encode_payload, zmk_input_stream_Notification_fields,
                             &sent[sent_count])) {
        rejected_count++;
        printk("at=%lld revoked dispatch rejected=%u\n", k_uptime_get(), rejected_count);
        return ZMK_EV_EVENT_BUBBLE;
    }
    if (sent[sent_count].which_notification_type == zmk_input_stream_Notification_key_event_tag) {
        printk("at=%lld dispatch=%u key=%u pressed=%u behavior=%u p1=%u p2=%u\n", k_uptime_get(),
               sent_count, sent[sent_count].notification_type.key_event.position,
               sent[sent_count].notification_type.key_event.pressed,
               sent[sent_count].notification_type.key_event.behavior_id,
               sent[sent_count].notification_type.key_event.param1,
               sent[sent_count].notification_type.key_event.param2);
    } else {
        printk("at=%lld dispatch=%u layer=%u\n", k_uptime_get(), sent_count,
               sent[sent_count].notification_type.layer_change.layer_index);
    }
    order[order_count++] = sent_count++;
    return ZMK_EV_EVENT_BUBBLE;
}
ZMK_EVENT_IMPL(zmk_studio_custom_notification);
ZMK_EVENT_IMPL(zmk_position_state_changed);
ZMK_EVENT_IMPL(zmk_layer_state_changed);
ZMK_LISTENER(test_transport, receive_notification);
ZMK_SUBSCRIPTION(test_transport, zmk_studio_custom_notification);
#include INPUT_STREAM_SOURCE

static void call_bytes(const uint8_t *bytes, size_t size, bool ok) {
    zmk_custom_CallRequest raw = {0};
    memcpy(raw.payload.bytes, bytes, size);
    raw.payload.size = size;
    pb_callback_t cb = {0};
    CHECK(input_stream_rpc_handle_request(&raw, &cb));
    zmk_input_stream_Response r = zmk_input_stream_Response_init_zero;
    decode_callback(cb, zmk_input_stream_Response_fields, &r);
    CHECK(r.which_response_type ==
          (ok ? zmk_input_stream_Response_ok_tag : zmk_input_stream_Response_error_tag));
    if (!ok)
        CHECK(r.response_type.error.message[0]);
}
static void stream_try(bool enabled, bool ok) {
    zmk_input_stream_Request req = zmk_input_stream_Request_init_zero;
    req.which_request_type = enabled ? zmk_input_stream_Request_enable_stream_tag
                                     : zmk_input_stream_Request_disable_stream_tag;
    uint8_t bytes[128];
    pb_ostream_t s = pb_ostream_from_buffer(bytes, sizeof(bytes));
    CHECK(pb_encode(&s, zmk_input_stream_Request_fields, &req));
    call_bytes(bytes, s.bytes_written, ok);
}
static void stream(bool enabled) { stream_try(enabled, true); }
static void key(uint32_t pos, bool state) {
    CHECK(raise_zmk_position_state_changed((struct zmk_position_state_changed){
              .position = pos, .state = state, .timestamp = 17}) == 0);
}
K_SEM_DEFINE(block_entered, 0, 1);
K_SEM_DEFINE(block_release, 0, 1);
static void block_fn(struct k_work *work) {
    ARG_UNUSED(work);
    k_sem_give(&block_entered);
    CHECK(k_sem_take(&block_release, K_MSEC(500)) == 0);
}
K_WORK_DEFINE(block_work, block_fn);
static void block(void) {
    CHECK(k_work_submit_to_queue(zmk_workqueue_lowprio_work_q(), &block_work) >= 0);
    CHECK(k_sem_take(&block_entered, K_MSEC(250)) == 0);
}
static void unblock(void) { k_sem_give(&block_release); }
static void peer_fn(struct k_work *work) {
    ARG_UNUSED(work);
    printk("at=%lld peer order=%u\n", k_uptime_get(), order_count);
    order[order_count++] = 99;
}
K_WORK_DEFINE(peer_work, peer_fn);
static void idle(void) {
    struct k_work_sync sync;
    while (k_work_flush(&notif_send_work, &sync)) {
    }
    k_work_flush(&peer_work, &sync);
}
K_THREAD_STACK_DEFINE(producer_stack, 2048);
static struct k_thread producer;
static void produce(void *a, void *b, void *c) {
    ARG_UNUSED(a);
    ARG_UNUSED(b);
    ARG_UNUSED(c);
    key(2, true);
}

int main(void) {
    const char *scenario = getenv("INPUT_STREAM_CASE");
    CHECK(scenario);
    if (!strcmp(scenario, "control")) {
        key(1, true);
        idle();
        CHECK(sent_count == 0);
        stream(true);
        stream(true);
        block();
        key(0, false);
        key(1, true);
        key(15, false);
        stream(true);
        layer_index = 2;
        CHECK(raise_zmk_layer_state_changed(
                  (struct zmk_layer_state_changed){.layer = 2, .state = true}) == 0);
        unblock();
        idle();
        CHECK(sent_count == 4);
        for (unsigned i = 0; i < 3; i++)
            CHECK(sent[i].which_notification_type == zmk_input_stream_Notification_key_event_tag);
        CHECK(sent[0].notification_type.key_event.position == 0 &&
              !sent[0].notification_type.key_event.pressed);
        CHECK(sent[1].notification_type.key_event.position == 1 &&
              sent[1].notification_type.key_event.pressed);
        CHECK(sent[1].notification_type.key_event.behavior_id == 42 &&
              sent[1].notification_type.key_event.param1 == UINT32_MAX &&
              sent[1].notification_type.key_event.param2 == 17);
        CHECK(sent[2].notification_type.key_event.behavior_id == 0 &&
              sent[2].notification_type.key_event.param1 == 0);
        CHECK(sent[3].which_notification_type == zmk_input_stream_Notification_layer_change_tag &&
              sent[3].notification_type.layer_change.layer_index == 2);
        const uint8_t bad[] = {0xff};
        call_bytes(bad, sizeof(bad), false);
        call_bytes(bad, 0, false);
        key(2, false);
        idle();
        CHECK(sent_count == 5 && sent[4].notification_type.key_event.position == 2);
        stream(false);
        key(1, false);
        idle();
        CHECK(sent_count == 5);
    } else if (!strcmp(scenario, "stop") || !strcmp(scenario, "restart")) {
        stream(true);
        block();
        key(1, true);
        key(1, false);
        stream(false);
        if (!strcmp(scenario, "restart")) {
            stream(true);
            key(3, true);
        }
        unblock();
        idle();
        unsigned want = !strcmp(scenario, "restart") ? 1 : 0;
        printk("queued stop/restart sent=%u expected=%u\n", sent_count, want);
        CHECK(sent_count == want);
        if (want)
            CHECK(sent[0].notification_type.key_event.position == 3);
    } else if (!strcmp(scenario, "full")) {
        stream(true);
        block();
        for (unsigned i = 0; i < 4; i++)
            key(i, true);
        key(0, false);
        key(4, true);
        key(5, true);
        unblock();
        idle();
        CHECK(sent_count == 4);
        for (unsigned i = 0; i < 4; i++)
            CHECK(sent[i].notification_type.key_event.position == i &&
                  sent[i].notification_type.key_event.pressed);
        printk("full queue: release lost, no wire resynchronization in this schema\n");
        key(0, false);
        idle();
        CHECK(sent_count == 5 && !sent[4].notification_type.key_event.pressed);
    } else if (!strcmp(scenario, "fair") || !strcmp(scenario, "blocking")) {
        stream(true);
        send_gate = true;
        key(0, true);
        CHECK(k_sem_take(&send_entered, K_MSEC(250)) == 0);
        CHECK(k_work_submit_to_queue(zmk_workqueue_lowprio_work_q(), &peer_work) >= 0);
        key(1, true);
        key(2, true);
        key(3, true);
        if (!strcmp(scenario, "blocking")) {
            stream(false);
            CHECK(order_count == 0);
        }
        k_sem_give(&send_release);
        idle();
        if (!strcmp(scenario, "fair")) {
            printk("peer order: %u %u %u %u %u\n", order[0], order[1], order[2], order[3],
                   order[4]);
            CHECK(order_count == 5 && order[0] == 0 && order[1] == 99 && sent_count == 4);
            for (unsigned i = 0; i < 4; i++)
                CHECK(sent[i].notification_type.key_event.position == i &&
                      sent[i].notification_type.key_event.pressed);
        } else {
            CHECK(sent_count == 0 && rejected_count == 1 && order_count == 1 && order[0] == 99);
        }
    } else if (!strcmp(scenario, "race")) {
        stream(true);
        block();
        binding_gate = true;
        k_thread_create(&producer, producer_stack, K_THREAD_STACK_SIZEOF(producer_stack), produce,
                        NULL, NULL, NULL, 5, 0, K_NO_WAIT);
        CHECK(k_sem_take(&binding_entered, K_MSEC(250)) == 0);
        stream(false);
        stream(true);
        k_sem_give(&binding_release);
        CHECK(k_thread_join(&producer, K_MSEC(250)) == 0);
        unblock();
        idle();
        printk("old producer after restart sent=%u\n", sent_count);
        CHECK(sent_count == 0);
    } else if (!strcmp(scenario, "locked")) {
        studio(false);
        stream_try(true, false);
        key(1, true);
        idle();
        CHECK(sent_count == 0);
        studio(true);
        stream(true);
        block();
        key(1, true);
        studio(false);
        unblock();
        idle();
        CHECK(sent_count == 0);
        studio(true);
        key(2, true);
        idle();
        CHECK(sent_count == 0); /* unlocking does not restore an old stream */
        stream(true);
        key(3, true);
        idle();
        CHECK(sent_count == 1 && sent[0].notification_type.key_event.position == 3);
    } else if (!strcmp(scenario, "lock-race")) {
        stream(true);
        block();
        binding_gate = true;
        k_thread_create(&producer, producer_stack, K_THREAD_STACK_SIZEOF(producer_stack), produce,
                        NULL, NULL, NULL, 5, 0, K_NO_WAIT);
        CHECK(k_sem_take(&binding_entered, K_MSEC(250)) == 0);
        studio(false);
        studio(true);
        stream(true);
        k_sem_give(&binding_release);
        CHECK(k_thread_join(&producer, K_MSEC(250)) == 0);
        unblock();
        idle();
        CHECK(sent_count == 0);
    } else if (!strcmp(scenario, "lock-dispatch")) {
        stream(true);
        send_gate = true;
        key(0, true);
        CHECK(k_sem_take(&send_entered, K_MSEC(250)) == 0);
        studio(false);
        studio(true);
        stream(true);
        key(2, true);
        k_sem_give(&send_release);
        idle();
        CHECK(rejected_count == 1 && sent_count == 1 &&
              sent[0].notification_type.key_event.position == 2);
    } else if (!strcmp(scenario, "encoding")) {
        stream(true);
        lock_after_sizing = true;
        key(0, true);
        idle();
        CHECK(sent_count == 1 && rejected_count == 0);
        CHECK(sent[0].notification_type.key_event.position == 0);
        key(2, true);
        idle();
        CHECK(sent_count == 1); /* committed frame finishes; future events stop */
    } else if (!strcmp(scenario, "endpoint")) {
        stream(true);
        block();
        key(1, true);
        CHECK(raise_zmk_endpoint_changed((struct zmk_endpoint_changed){0}) == 0);
        unblock();
        idle();
        key(2, true);
        idle();
        CHECK(sent_count == 0);
        stream(true);
        key(3, true);
        idle();
        CHECK(sent_count == 1 && sent[0].notification_type.key_event.position == 3);
    } else if (!strcmp(scenario, "lookup")) {
        key(0, true);
        idle();
        CHECK(sent_count == 0 && test_subsystem_lookups == 0);
        stream(true);
        for (unsigned i = 0; i < 3; i++) {
            key(i, true);
            idle();
            CHECK(sent_count == i + 1);
            CHECK(sent[i].notification_type.key_event.position == i);
            CHECK(test_subsystem_lookups == 2);
        }
        stream(false);
        key(3, true);
        idle();
        CHECK(sent_count == 3 && test_subsystem_lookups == 2);
        stream(true);
        key(3, false);
        idle();
        CHECK(sent_count == 4 && !sent[3].notification_type.key_event.pressed);
        CHECK(test_subsystem_lookups == 2);
        studio(false);
        key(4, true);
        idle();
        CHECK(sent_count == 4 && test_subsystem_lookups == 2);
    } else if (!strcmp(scenario, "missing")) {
        stream(true);
        test_subsystem_count = 1;
        key(1, true);
        idle();
        CHECK(sent_count == 0);
        test_subsystem_count = 2;
        key(1, false);
        idle();
        CHECK(sent_count == 1);
        CHECK(test_subsystem_lookups == 3);
        key(2, true);
        idle();
        CHECK(sent_count == 2 && sent[1].notification_type.key_event.position == 2);
        CHECK(test_subsystem_lookups == 3);
    } else {
        printk("unknown scenario\n");
        exit(2);
    }
    printk("PASS input-stream sender %s\n", scenario);
    exit(0);
}
