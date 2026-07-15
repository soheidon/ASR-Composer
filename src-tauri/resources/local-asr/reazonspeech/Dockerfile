FROM asr-composer-base:cu126
LABEL com.asr-composer.engine="reazonspeech"
LABEL com.asr-composer.environment-version="1.0.0"
LABEL com.asr-composer.asr-model="reazon-research/reazonspeech-espnet-v2"

# pip/setuptools/wheel をビルド時に固定
ARG PIP_VERSION=25.1.1
ARG SETUPTOOLS_VERSION=80.9.0
ARG WHEEL_VERSION=0.45.1

# ---- venv-diar: 話者分離環境 ----
RUN python3.11 -m venv /opt/venv-diar
RUN /opt/venv-diar/bin/pip install \
    pip==${PIP_VERSION} \
    setuptools==${SETUPTOOLS_VERSION} \
    wheel==${WHEEL_VERSION}

# PyTorchは公式インデックスから直接インストール
RUN /opt/venv-diar/bin/pip install \
    torch==2.8.0 \
    torchaudio==2.8.0 \
    --index-url https://download.pytorch.org/whl/cu126

COPY common/requirements-diar.txt /tmp/requirements-diar.txt
RUN /opt/venv-diar/bin/pip install --no-cache-dir -r /tmp/requirements-diar.txt

# ---- venv-asr: ReazonSpeech環境 ----
RUN python3.11 -m venv /opt/venv-asr
RUN /opt/venv-asr/bin/pip install \
    pip==${PIP_VERSION} \
    setuptools==${SETUPTOOLS_VERSION} \
    wheel==${WHEEL_VERSION}

# venv-asrにもCUDA版PyTorchを明示的に導入
RUN /opt/venv-asr/bin/pip install \
    torch==2.8.0 \
    torchaudio==2.8.0 \
    --index-url https://download.pytorch.org/whl/cu126

COPY reazonspeech/requirements-asr.txt /tmp/requirements-asr.txt
RUN /opt/venv-asr/bin/pip install --no-cache-dir -r /tmp/requirements-asr.txt

# ReazonSpeech ESPnet（v3.0.0タグ固定）
ARG REAZONSPEECH_REF=v3.0.0
RUN git clone https://github.com/reazon-research/ReazonSpeech /tmp/ReazonSpeech \
    && cd /tmp/ReazonSpeech \
    && git checkout ${REAZONSPEECH_REF} \
    && /opt/venv-asr/bin/pip install --no-cache-dir /tmp/ReazonSpeech/pkg/espnet-asr \
    && rm -rf /tmp/ReazonSpeech

# ctc-segmentationを実行環境のNumPy 2.xに対して再コンパイルする
# （隔離ビルド環境ではNumPy 1.xでコンパイルされABI不一致になるため）
RUN /opt/venv-asr/bin/pip uninstall -y ctc-segmentation \
    && /opt/venv-asr/bin/pip install \
       --no-cache-dir \
       --no-build-isolation \
       --no-binary=ctc-segmentation \
       ctc-segmentation==1.7.4

# NumPy / ctc-segmentation / ESPnet / torch / CUDA 整合性確認
RUN /opt/venv-asr/bin/python -c \
    "import numpy, torch, torchaudio, ctc_segmentation, espnet; \
     assert torch.__version__.startswith('2.8.0'), f'torch version mismatch: {torch.__version__}'; \
     assert torch.version.cuda == '12.6', f'CUDA version mismatch: {torch.version.cuda}'; \
     print(f'numpy {numpy.__version__}, torch {torch.__version__}, ctc_segmentation OK, espnet OK')"

# 両venvの依存整合性チェック
RUN /opt/venv-diar/bin/pip check
RUN /opt/venv-asr/bin/pip check

# HFキャッシュをマウント先に固定
ENV HF_HOME=/work/hf_cache
ENV HUGGINGFACE_HUB_CACHE=/work/hf_cache/hub
ENV TRANSFORMERS_CACHE=/work/hf_cache/transformers
ENV TMPDIR=/work/tmp
ENV TEMP=/work/tmp
ENV TMP=/work/tmp

# スクリプト配置
COPY common/orchestrator.py /app/orchestrator.py
COPY common/diarize.py /app/diarize.py
COPY common/output_writer.py /app/output_writer.py
COPY common/smoke_test.py /app/smoke_test.py
COPY reazonspeech/transcribe.py /app/transcribe.py

ENV ASR_ENGINE=reazonspeech
ENV VENV_DIAR=/opt/venv-diar
ENV VENV_ASR=/opt/venv-asr

CMD ["python3.11", "/app/orchestrator.py"]
