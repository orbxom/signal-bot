FROM eclipse-temurin:21-jre

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

ARG SIGNAL_CLI_VERSION=0.13.24
RUN curl -L "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz" \
    | tar xz -C /opt

ENV PATH="/opt/signal-cli-${SIGNAL_CLI_VERSION}/bin:${PATH}"

RUN mkdir -p /var/lib/signal-cli

EXPOSE 8080

ENTRYPOINT ["signal-cli"]
CMD ["--config", "/var/lib/signal-cli", "daemon", "--http", "0.0.0.0:8080", "--receive-mode", "manual"]
