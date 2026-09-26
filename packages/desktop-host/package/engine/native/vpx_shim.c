/*
 * Thin C surface over libvpx's VP9 encoder.
 *
 * libvpx configures its encoder through a large versioned struct whose layout
 * follows the *header the library was built against*, not the one on this
 * machine. Doing that configuration in C, where the compiler and the headers
 * agree, keeps a wrong offset from silently producing a broken stream; the
 * Rust side only ever sees an opaque handle and a byte slice.
 *
 * libvpx is BSD-3-Clause. No code here is derived from any encoder
 * implementation: it is the documented configuration path for the public API.
 */

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <vpx/vp8cx.h>
#include <vpx/vpx_codec.h>
#include <vpx/vpx_encoder.h>
#include <vpx/vpx_image.h>

/* The quantizer ceiling while the desktop moves. Refinement frames lower it. */
#define DL_VPX_MOTION_MAX_Q 52

typedef struct {
    vpx_codec_ctx_t ctx;
    vpx_codec_enc_cfg_t cfg;
    int width;
    int height;
    int frame_index;
    /* The packet libvpx last produced; valid until the next encode call. */
    const void *packet;
    size_t packet_size;
    int packet_is_key;
} dl_vpx_encoder;

/* Returns NULL when libvpx refuses the configuration, which is reported rather
 * than papered over: a silently unconfigured encoder looks like a network bug. */
dl_vpx_encoder *dl_vpx_create(int width, int height, int bitrate_kbps, int fps,
                              int threads, int cpu_used) {
    if (width <= 0 || height <= 0 || bitrate_kbps <= 0 || fps <= 0) {
        return NULL;
    }
    dl_vpx_encoder *self = calloc(1, sizeof(dl_vpx_encoder));
    if (self == NULL) {
        return NULL;
    }
    vpx_codec_iface_t *iface = vpx_codec_vp9_cx();
    if (vpx_codec_enc_config_default(iface, &self->cfg, 0) != VPX_CODEC_OK) {
        free(self);
        return NULL;
    }

    self->cfg.g_w = (unsigned int)width;
    self->cfg.g_h = (unsigned int)height;
    self->cfg.g_timebase.num = 1;
    self->cfg.g_timebase.den = fps;
    self->cfg.g_profile = 0;
    self->cfg.g_bit_depth = VPX_BITS_8;
    self->cfg.g_input_bit_depth = 8;
    self->cfg.g_pass = VPX_RC_ONE_PASS;
    self->cfg.g_lag_in_frames = 0;
    self->cfg.g_threads = (unsigned int)(threads < 1 ? 1 : threads);
    self->cfg.rc_end_usage = VPX_CBR;
    self->cfg.rc_target_bitrate = (unsigned int)bitrate_kbps;
    self->cfg.rc_min_quantizer = 2;
    self->cfg.rc_max_quantizer = DL_VPX_MOTION_MAX_Q;
    self->cfg.rc_buf_sz = 1000;
    self->cfg.rc_buf_initial_sz = 500;
    self->cfg.rc_buf_optimal_sz = 600;
    self->cfg.rc_undershoot_pct = 50;
    self->cfg.rc_overshoot_pct = 50;
    self->cfg.rc_dropframe_thresh = 0;
    /* Key frames only when asked: the first frame, a receiver that lost its
     * reference (PLI/FIR) or a transport that just connected. On a desktop a
     * periodic key frame is the most expensive frame in the stream and the one
     * that resets a sharp picture to a soft one. */
    self->cfg.kf_mode = VPX_KF_DISABLED;

    if (vpx_codec_enc_init(&self->ctx, iface, &self->cfg, 0) != VPX_CODEC_OK) {
        free(self);
        return NULL;
    }
    vpx_codec_control(&self->ctx, VP8E_SET_CPUUSED, cpu_used);
    /* A key frame may take several frames' budget: it is rare, and a starved
     * one is a soft picture until the refinement pass lands. */
    vpx_codec_control(&self->ctx, VP8E_SET_MAX_INTRA_BITRATE_PCT, 900);
    vpx_codec_control(&self->ctx, VP9E_SET_ROW_MT, 1);
    /* Screen content: text and flat colour, not camera noise. This is what
     * keeps glyph edges instead of smearing them into blocks. */
    vpx_codec_control(&self->ctx, VP9E_SET_TUNE_CONTENT, VP9E_CONTENT_SCREEN);
    /* Cyclic refresh re-codes static areas at a finer quantizer over the next
     * frames, so an unchanged desktop keeps converging on sharp. */
    vpx_codec_control(&self->ctx, VP9E_SET_AQ_MODE, 3);
    vpx_codec_control(&self->ctx, VP9E_SET_NOISE_SENSITIVITY, 0);
    /* Columns let the encoder and the phone's decoder split a 4K frame; libvpx
     * caps this at what the width allows. */
    vpx_codec_control(&self->ctx, VP9E_SET_TILE_COLUMNS, 3);
    vpx_codec_control(&self->ctx, VP9E_SET_COLOR_SPACE, VPX_CS_BT_601);

    self->width = width;
    self->height = height;
    return self;
}

/* Encode one tightly packed I420 frame. Returns:
 *   1  a packet is available through dl_vpx_packet_*
 *   0  libvpx held the frame (should not happen with zero lookahead)
 *  -1  libvpx rejected the frame
 */
int dl_vpx_encode(dl_vpx_encoder *self, const uint8_t *i420, int force_keyframe) {
    if (self == NULL || i420 == NULL) {
        return -1;
    }
    vpx_image_t image;
    if (vpx_img_wrap(&image, VPX_IMG_FMT_I420, (unsigned int)self->width,
                     (unsigned int)self->height, 1, (unsigned char *)i420) == NULL) {
        return -1;
    }
    if (vpx_codec_encode(&self->ctx, &image, self->frame_index, 1,
                         force_keyframe ? VPX_EFLAG_FORCE_KF : 0,
                         VPX_DL_REALTIME) != VPX_CODEC_OK) {
        return -1;
    }
    self->frame_index++;

    self->packet = NULL;
    self->packet_size = 0;
    vpx_codec_iter_t iter = NULL;
    const vpx_codec_cx_pkt_t *pkt;
    while ((pkt = vpx_codec_get_cx_data(&self->ctx, &iter)) != NULL) {
        if (pkt->kind != VPX_CODEC_CX_FRAME_PKT) {
            continue;
        }
        self->packet = pkt->data.frame.buf;
        self->packet_size = pkt->data.frame.sz;
        self->packet_is_key = (pkt->data.frame.flags & VPX_FRAME_IS_KEY) != 0;
        break;
    }
    return self->packet == NULL ? 0 : 1;
}

/* Change the rate target and the quantizer ceiling for the frames that follow.
 * A low ceiling on an unchanged frame is a refinement pass: the encoder spends
 * what it takes to make the picture sharp, once, instead of every frame.
 * Returns 0 on success. */
int dl_vpx_reconfigure(dl_vpx_encoder *self, int bitrate_kbps, int max_quantizer) {
    if (self == NULL || bitrate_kbps <= 0) {
        return -1;
    }
    if (max_quantizer < (int)self->cfg.rc_min_quantizer) {
        max_quantizer = (int)self->cfg.rc_min_quantizer;
    }
    if (max_quantizer > 63) {
        max_quantizer = 63;
    }
    if (self->cfg.rc_target_bitrate == (unsigned int)bitrate_kbps &&
        self->cfg.rc_max_quantizer == (unsigned int)max_quantizer) {
        return 0;
    }
    self->cfg.rc_target_bitrate = (unsigned int)bitrate_kbps;
    self->cfg.rc_max_quantizer = (unsigned int)max_quantizer;
    return vpx_codec_enc_config_set(&self->ctx, &self->cfg) == VPX_CODEC_OK ? 0 : -1;
}

int dl_vpx_motion_max_q(void) { return DL_VPX_MOTION_MAX_Q; }

const uint8_t *dl_vpx_packet_data(const dl_vpx_encoder *self) {
    return (const uint8_t *)self->packet;
}

size_t dl_vpx_packet_size(const dl_vpx_encoder *self) { return self->packet_size; }

int dl_vpx_packet_is_key(const dl_vpx_encoder *self) { return self->packet_is_key; }

void dl_vpx_destroy(dl_vpx_encoder *self) {
    if (self == NULL) {
        return;
    }
    vpx_codec_destroy(&self->ctx);
    free(self);
}
