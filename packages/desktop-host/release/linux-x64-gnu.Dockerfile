# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
#
# The prebuilt Linux x64 (glibc) engine, built from this package's source with
# every input pinned: the base images by digest, system packages by a fixed
# Debian snapshot, the Rust toolchain by version, libvpx by commit, and the
# crates by Cargo.lock. Run through `release/build-engine.sh`; nothing here
# publishes anything.
#
# Debian 12 sets the floor: the executable needs glibc 2.36 or newer, and the
# engine's PipeWire bindings need PipeWire 0.3.65 headers, which older
# distributions (Ubuntu 22.04's 0.3.48) do not have.

ARG BASE_IMAGE=debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
ARG APT_SNAPSHOT=20260920T000000Z
ARG RUSTUP_VERSION=1.29.1
ARG RUSTUP_SHA256=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71
ARG RUST_VERSION=1.97.1
ARG LIBVPX_TAG=v1.16.0
ARG LIBVPX_COMMIT=1024874c5919305883187e2953de8fcb4c3d7fa6

FROM ${BASE_IMAGE} AS build
ARG DEBIAN_FRONTEND=noninteractive
ARG APT_SNAPSHOT
RUN rm -f /etc/apt/sources.list.d/debian.sources \
    && printf 'deb http://snapshot.debian.org/archive/%s/%s %s main\n' \
        debian "$APT_SNAPSHOT" bookworm debian "$APT_SNAPSHOT" bookworm-updates \
        debian-security "$APT_SNAPSHOT" bookworm-security > /etc/apt/sources.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install -y --no-install-recommends \
        build-essential ca-certificates cmake curl git libclang-dev nasm pkg-config \
        libevdev-dev libpipewire-0.3-dev libwayland-dev libxcb1-dev libxkbcommon-dev \
    && rm -rf /var/lib/apt/lists/*

ARG RUSTUP_VERSION
ARG RUSTUP_SHA256
ARG RUST_VERSION
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -fsSLo /tmp/rustup-init \
        "https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/x86_64-unknown-linux-gnu/rustup-init" \
    && echo "$RUSTUP_SHA256  /tmp/rustup-init" | sha256sum -c - \
    && chmod +x /tmp/rustup-init \
    && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "$RUST_VERSION" \
    && rm /tmp/rustup-init

# Static libvpx, VP9 encoder only. Runtime CPU detection stays on, so the SIMD
# paths are chosen on the machine that runs the engine, not this one.
ARG LIBVPX_TAG
ARG LIBVPX_COMMIT
RUN git clone --quiet --depth 1 --branch "$LIBVPX_TAG" https://chromium.googlesource.com/webm/libvpx /opt/libvpx-src \
    && test "$(git -C /opt/libvpx-src rev-parse HEAD)" = "$LIBVPX_COMMIT" \
    && cd /opt/libvpx-src \
    && ./configure --prefix=/opt/libvpx --enable-pic --enable-static --disable-shared \
        --disable-vp8 --disable-vp9-decoder --disable-examples --disable-tools --disable-docs --disable-unit-tests \
    && make -j"$(nproc)" \
    && make install

WORKDIR /src/engine
COPY engine/Cargo.toml engine/Cargo.lock engine/build.rs ./
COPY engine/native ./native
COPY engine/vendor ./vendor
COPY engine/src ./src
RUN cargo metadata --locked --format-version 1 --filter-platform x86_64-unknown-linux-gnu > /tmp/cargo-metadata.json \
    && DESKLINK_VPX_STATIC_DIR=/opt/libvpx cargo build --locked --release --bin desklink-host

# The properties a distributed executable must have, checked here so a build
# that lacks them never leaves this stage.
RUN set -eu; bin=target/release/desklink-host; \
    if readelf -d "$bin" | grep -q 'libvpx'; then echo 'libvpx is dynamically linked' >&2; exit 1; fi; \
    newest=$(objdump -T "$bin" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1); \
    if [ "$(printf '%s\nGLIBC_2.36\n' "$newest" | sort -V | tail -1)" != GLIBC_2.36 ]; then echo "needs $newest" >&2; exit 1; fi; \
    "./$bin" version

FROM ${NODE_IMAGE} AS notices
ARG RUST_VERSION
COPY --from=build /opt/cargo/registry/src /opt/cargo/registry/src
COPY --from=build /opt/rustup/toolchains/${RUST_VERSION}-x86_64-unknown-linux-gnu/share/doc/rust/COPYRIGHT-library.html \
    /out/COPYRIGHT-rust-library.html
COPY --from=build /opt/libvpx-src/LICENSE /opt/libvpx-src/PATENTS /inputs/libvpx/
COPY --from=build /tmp/cargo-metadata.json /inputs/
COPY engine/vendor/inputtino/LICENSE /inputs/inputtino/
COPY LICENSE /inputs/Apache-2.0.txt
COPY release/notices.mjs /notices.mjs
RUN node /notices.mjs /inputs > /out/THIRD_PARTY_LICENSES.txt

FROM build AS provenance
ARG BASE_IMAGE
ARG APT_SNAPSHOT
ARG LIBVPX_TAG
ARG LIBVPX_COMMIT
# Last, so a new commit re-stamps provenance without rebuilding the engine.
ARG SOURCE_COMMIT=unknown
ARG SOURCE_DIRTY=null
COPY --from=notices /out/ /out/
RUN cp target/release/desklink-host /out/ \
    && printf '{\n  "engine": "%s",\n  "target": "x86_64-unknown-linux-gnu",\n  "sha256": "%s",\n  "source": { "commit": "%s", "dirty": %s },\n  "baseImage": "%s",\n  "aptSnapshot": "%s",\n  "rust": "%s",\n  "libvpx": { "tag": "%s", "commit": "%s", "linkage": "static" },\n  "inputtino": "vendored, linked statically",\n  "glibc": ">=2.36"\n}\n' \
        "$(/out/desklink-host version)" "$(sha256sum /out/desklink-host | cut -d' ' -f1)" \
        "$SOURCE_COMMIT" "$SOURCE_DIRTY" "$BASE_IMAGE" "$APT_SNAPSHOT" "$(rustc --version)" "$LIBVPX_TAG" "$LIBVPX_COMMIT" \
        > /out/provenance.json

FROM scratch
COPY --from=provenance /out/ /
