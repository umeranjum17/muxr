/* The two permissive native APIs the engine links. Kept in one translation
 * unit so bindgen sees the same libc types for both. */
#include <vpx/vpx_codec.h>
#include <vpx/vpx_encoder.h>
#include <vpx/vpx_image.h>
#include <vpx/vp8cx.h>
#include <inputtino/input.h>
