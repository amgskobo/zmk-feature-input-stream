cmake_minimum_required(VERSION 3.20.0)
list(APPEND DTS_ROOT "${ZMK_ROOT}/app")
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(input_stream_sender)
if(NOT INPUT_STREAM_SOURCE)
  set(INPUT_STREAM_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/../../src/studio/input_stream_handler.c")
endif()
target_sources(app PRIVATE main.c logging.c "${ZMK_ROOT}/app/src/event_manager.c"
  "${ZMK_ROOT}/app/src/workqueue.c" "${GENERATED_ROOT}/zmk/input_stream/input_stream.pb.c"
  "${GENERATED_ROOT}/envelope.pb.c"
  "${NANOPB_ROOT}/pb_common.c" "${NANOPB_ROOT}/pb_encode.c" "${NANOPB_ROOT}/pb_decode.c")
target_include_directories(app PRIVATE include "${GENERATED_ROOT}" "${NANOPB_ROOT}"
  "${ZMK_ROOT}/app/include")
target_compile_definitions(app PRIVATE INPUT_STREAM_SOURCE="${INPUT_STREAM_SOURCE}"
  CONFIG_ZMK_LOG_LEVEL=0 CONFIG_ZMK_INPUT_STREAM_NOTIF_QUEUE_SIZE=4
  CONFIG_ZMK_BEHAVIOR_LOCAL_IDS=1 CONFIG_ZMK_LOW_PRIORITY_THREAD_STACK_SIZE=4096
  CONFIG_ZMK_LOW_PRIORITY_THREAD_PRIORITY=10 PB_WITHOUT_64BIT=1)
zephyr_linker_sources(RODATA "${ZMK_ROOT}/app/include/linker/zmk-events.ld")
