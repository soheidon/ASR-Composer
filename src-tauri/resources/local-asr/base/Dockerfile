FROM nvidia/cuda:12.6.0-cudnn-runtime-ubuntu22.04
LABEL com.asr-composer.component="base"
LABEL com.asr-composer.version="1.0.0"

ENV DEBIAN_FRONTEND=noninteractive

# deadsnakes PPAでPython 3.11をインストール
RUN apt-get update \
    && apt-get install -y --no-install-recommends software-properties-common \
    && add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       python3.11 python3.11-venv python3.11-dev \
       ffmpeg git ca-certificates \
       libsndfile1 libsndfile1-dev \
       build-essential gcc g++ make cmake pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
