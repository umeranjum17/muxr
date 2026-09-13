# Systemd-capable gate image: real PID 1 so `muxr daemon` supervises the
# relay+host through a genuine user service manager. Node 22 copied from the
# official image; non-root user `gate`; global npm prefix needs no sudo.
# Run with: --privileged --cgroupns=host
#
# Build (from this directory; the real local herdr binary goes in first):
#   cp "$(command -v herdr)" ./herdr
#   docker build -t muxr-gate-systemd:1 .
#   rm ./herdr
FROM node:22-bookworm-slim AS nodelayer

FROM debian:bookworm-slim
ENV container=docker \
    HOME=/home/gate \
    PATH=/home/gate/.npm-global/bin:/usr/local/bin:/usr/bin:/bin \
    NPM_CONFIG_PREFIX=/home/gate/.npm-global
COPY --from=nodelayer /usr/local /usr/local
RUN apt-get update \
    && apt-get install -y --no-install-recommends systemd systemd-sysv dbus libpam-systemd login passwd adduser git curl ca-certificates iproute2 procps sudo \
    && rm -rf /var/lib/apt/lists/* \
    && npm config set fund false \
    && npm config set audit false \
    && (command -v useradd >/dev/null || apt-get install -y --no-install-recommends passwd) \
    && /usr/sbin/useradd -m -s /bin/bash gate \
    && printf 'd /run/user/1000 0700 gate gate -\n' > /etc/tmpfiles.d/gate-runtime.conf \
    && echo "gate ALL=(ALL) NOPASSWD: /bin/loginctl" > /etc/sudoers.d/gate-linger \
    && chmod 0440 /etc/sudoers.d/gate-linger
COPY herdr /usr/local/bin/herdr
RUN chmod +x /usr/local/bin/herdr \
    && chown -R gate:gate /home/gate
# NOTE: no USER directive -- PID 1 systemd must run as root; gate work
# happens via `docker exec -u gate` with HOME from ENV below.
WORKDIR /home/gate
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
