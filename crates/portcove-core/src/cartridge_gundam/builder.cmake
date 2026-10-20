# Fixed offline project for the authenticated Gundam source recipe.
cmake_minimum_required(VERSION 3.20)
project(GundamWingEndlessDuelSNESRecomp C CXX)
set(CMAKE_C_STANDARD 11)
set(SNESRECOMP_ROOT "${CMAKE_SOURCE_DIR}/snesrecomp")
set(SNESRECOMP_SDL_BACKEND SDL2 CACHE STRING "" FORCE)
set(SNESRECOMP_SDL3_FETCH OFF CACHE BOOL "" FORCE)
set(SNESRECOMP_ENABLE_MODS OFF CACHE BOOL "" FORCE)
set(SNESRECOMP_ENABLE_NET OFF CACHE BOOL "" FORCE)
set(SNESRECOMP_NET_ICE OFF CACHE BOOL "" FORCE)
set(SNESRECOMP_ENABLE_LUA OFF CACHE BOOL "" FORCE)
set(SNESRECOMP_ENABLE_TRACE OFF CACHE BOOL "" FORCE)
set(SNES_COSIM OFF CACHE BOOL "" FORCE)
set(SNESRECOMP_SETUP_HOST OFF CACHE BOOL "" FORCE)
set(SNESRECOMP_STATIC_RUNTIME OFF CACHE BOOL "" FORCE)
set(FETCHCONTENT_FULLY_DISCONNECTED ON CACHE BOOL "" FORCE)
set(FETCHCONTENT_UPDATES_DISCONNECTED ON CACHE BOOL "" FORCE)
include(${SNESRECOMP_ROOT}/runner/runner.cmake)
add_executable(GundamWingEndlessDuelSNESRecomp
    ${SNESRECOMP_RUNNER_SOURCES}
    ${SNESRECOMP_ROOT}/runner/src/netplay/snes_state_digest.c
    src/main.c
    src/host_contract.c
    src/codegen_setup.c
    src/game_rtl.c
    src/gwed_display.c
    src/gwed_ws_patch.c
    src/gen_stubs.c
    src/portcove_no_mods.c
    portcove-presentation/common/recomp_frame_blend.c
    portcove-presentation/common/recomp_flash_guard.c)
snesrecomp_target_mod_catalog(GundamWingEndlessDuelSNESRecomp NONE)
snesrecomp_target_generated_code(GundamWingEndlessDuelSNESRecomp
    ${CMAKE_SOURCE_DIR}/src/gen)
target_include_directories(GundamWingEndlessDuelSNESRecomp PRIVATE
    ${SNESRECOMP_RUNNER_INCLUDE_DIRS}
    ${SNESRECOMP_ROOT}/runner/src/desktop
    ${CMAKE_SOURCE_DIR}/src
    ${CMAKE_SOURCE_DIR}/recomp
    ${CMAKE_SOURCE_DIR}/portcove-presentation)
target_link_libraries(GundamWingEndlessDuelSNESRecomp PRIVATE
    ${SNESRECOMP_RUNNER_LIBRARIES})
snesrecomp_target_mmx_config(GundamWingEndlessDuelSNESRecomp)
target_compile_definitions(GundamWingEndlessDuelSNESRecomp PRIVATE
    GWED_BUILD_ID="portcove-c7aaaa152192-offline-v1"
    GWED_STATE_ID="pc-c7aaaa-offline-v1"
    SNES_GAME_VERSION="portcove-source-c7aaaa152192"
    SNES_GAME_TITLE="Gundam Wing Endless Duel")
snesrecomp_target_sdl(GundamWingEndlessDuelSNESRecomp)
