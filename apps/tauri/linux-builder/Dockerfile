FROM --platform=linux/amd64 rust:latest

RUN apt-get update && apt-get install -y \
    libwebkit2gtk-4.1-dev \
    build-essential \
    curl \
    wget \
    file \
    libssl-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev\
    librsvg2-dev \
    xdg-utils

RUN cargo install tauri-cli

RUN rustup target add x86_64-unknown-linux-gnu # add the target for the specific architecture

CMD cargo tauri build
