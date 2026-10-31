/* SPDX-License-Identifier: MIT */
#pragma once
#include <pb.h>
#include <pb_encode.h>
#include <zmk/event_manager.h>
#include <zmk/input_stream/input_stream.pb.h>

/* Controlled RPC registry/envelope/transport, not a Studio delivery test. */
typedef struct {
    struct {
        size_t size;
        uint8_t bytes[128];
    } payload;
} zmk_custom_CallRequest;
struct zmk_rpc_custom_subsystem_meta {
    const char *url;
    unsigned security;
};
struct zmk_rpc_custom_subsystem {
    const char *identifier;
};
#define ZMK_STUDIO_RPC_HANDLER_SECURED 1
#define ZMK_RPC_CUSTOM_SUBSYSTEM_UI_URLS(value) .url = value
extern struct zmk_rpc_custom_subsystem test_subsystems[2];
extern size_t test_subsystem_count;
extern unsigned test_subsystem_lookups;
#define STRUCT_SECTION_COUNT(type, count) (*(count) = test_subsystem_count)
#define STRUCT_SECTION_GET(type, i, value)                                                         \
    (test_subsystem_lookups++, *(value) = &test_subsystems[i])
#define ZMK_RPC_CUSTOM_SUBSYSTEM(id, meta, handler)                                                \
    static bool handler(const zmk_custom_CallRequest *, pb_callback_t *);
#define ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER(id, type) static type response_buffer
#define ZMK_RPC_CUSTOM_SUBSYSTEM_RESPONSE_BUFFER_ALLOCATE(id, callback)                            \
    test_allocate_response(callback)
zmk_input_stream_Response *test_allocate_response(pb_callback_t *callback);
bool zmk_rpc_custom_subsystem_encode_response_payload(pb_ostream_t *, const pb_field_t *,
                                                      const pb_msgdesc_t *, const void *);
struct zmk_studio_custom_notification {
    uint8_t subsystem_index;
    pb_callback_t encode_payload;
};
ZMK_EVENT_DECLARE(zmk_studio_custom_notification);
