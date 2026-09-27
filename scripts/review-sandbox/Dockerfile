FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git jq nginx openssl tini util-linux openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 10001 -s /bin/bash reviewer \
    && mkdir -p /opt/review /srv/review-workspace /tmp/nginx-client /tmp/nginx-proxy \
    && chown -R reviewer:reviewer /opt/review /srv/review-workspace /tmp/nginx-client /tmp/nginx-proxy

ARG CLI_SHA256=c889b8aa1ba5f5b34fafe715f37fd3b39e0ec8da7c719c00481971b71139f926
RUN curl -fL --retry 3 https://github.com/umeranjum17/muxr/releases/download/v0.2.1/trymuxr-cli-0.2.1.tgz -o /tmp/muxr.tgz \
    && echo "$CLI_SHA256  /tmp/muxr.tgz" | sha256sum -c - \
    && npm install --prefix /opt/review --ignore-scripts --no-audit --no-fund /tmp/muxr.tgz \
    && ln -s /opt/review/node_modules/@trymuxr/cli/cli.mjs /usr/local/bin/muxr \
    && rm /tmp/muxr.tgz

COPY scripts/review-sandbox/invite.mjs scripts/review-sandbox/review-agent.sh scripts/review-sandbox/launch.sh /opt/review/
COPY scripts/review-sandbox/nginx.conf /opt/review/nginx.conf
RUN chmod 755 /opt/review/launch.sh /opt/review/review-agent.sh \
    && chown reviewer:reviewer /opt/review/invite.mjs /opt/review/review-agent.sh /opt/review/launch.sh /opt/review/nginx.conf

USER reviewer
ENV HOME=/home/reviewer PATH=/home/reviewer/.local/bin:/usr/local/bin:/usr/bin:/bin MUXR_HOME=/home/reviewer/.muxr
RUN curl -fsSL --connect-timeout 10 --max-time 60 https://herdr.dev/install.sh -o /tmp/herdr-install.sh \
    && sh /tmp/herdr-install.sh && herdr --version && rm /tmp/herdr-install.sh

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/opt/review/launch.sh"]
