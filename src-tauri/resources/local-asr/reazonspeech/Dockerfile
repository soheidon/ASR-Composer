FROM asr-composer-base:cu126
LABEL com.asr-composer.engine="reazonspeech"
LABEL com.asr-composer.environment-version="2.0.0"
LABEL com.asr-composer.asr-model="reazon-research/reazonspeech-espnet-v2"

# pip/setuptools/wheel をビルド時に固定
ARG PIP_VERSION=25.1.1
ARG SETUPTOOLS_VERSION=80.9.0
ARG WHEEL_VERSION=0.45.1

# constraints配置（numpy/torch/torchaudioのバージョンを全pipへ固定）
COPY common/constraints-reazonspeech.txt /tmp/constraints.txt

# ---- 単一venv: torch ----
RUN echo "ASR_PROGRESS:installing-torch" \
    && python3.11 -m venv /opt/venv \
    && /opt/venv/bin/pip install \
       pip==${PIP_VERSION} \
       setuptools==${SETUPTOOLS_VERSION} \
       wheel==${WHEEL_VERSION} \
    && /opt/venv/bin/pip install \
       torch==2.8.0 \
       torchaudio==2.8.0 \
       --index-url https://download.pytorch.org/whl/cu126 \
    && /opt/venv/bin/python -c \
       "import torch, torchaudio; \
        assert torch.__version__ == '2.8.0+cu126', torch.__version__; \
        assert torchaudio.__version__ == '2.8.0+cu126', torchaudio.__version__; \
        assert torch.version.cuda == '12.6'; \
        print(f'torch={torch.__version__} torchaudio={torchaudio.__version__}')"

# ---- 話者分離依存（pyannote + huggingface_hub） ----
COPY common/requirements-diar.txt /tmp/requirements-diar.txt

RUN echo "ASR_PROGRESS:installing-pyannote" \
    && /opt/venv/bin/pip install \
       --no-cache-dir \
       -c /tmp/constraints.txt \
       --extra-index-url https://download.pytorch.org/whl/cu126 \
       -r /tmp/requirements-diar.txt \
    && /opt/venv/bin/python -c \
       "import torch, torchaudio, numpy; \
        assert torch.__version__ == '2.8.0+cu126', torch.__version__; \
        assert torchaudio.__version__ == '2.8.0+cu126', torchaudio.__version__; \
        print(f'torch={torch.__version__} numpy={numpy.__version__}')"

# ---- ASR依存（pydub, tqdm） ----
COPY reazonspeech/requirements-asr.txt /tmp/requirements-asr.txt

RUN echo "ASR_PROGRESS:installing-reazonspeech" \
    && /opt/venv/bin/pip install \
       --no-cache-dir \
       -c /tmp/constraints.txt \
       --extra-index-url https://download.pytorch.org/whl/cu126 \
       -r /tmp/requirements-asr.txt \
    && /opt/venv/bin/python -c \
       "import torch, torchaudio, numpy; \
        assert torch.__version__ == '2.8.0+cu126', torch.__version__; \
        print(f'torch={torch.__version__} numpy={numpy.__version__}')"

# ReazonSpeech ESPnet（v3.0.0タグ固定）
ARG REAZONSPEECH_REF=v3.0.0
RUN echo "ASR_PROGRESS:installing-espnet" \
    && git clone https://github.com/reazon-research/ReazonSpeech /tmp/ReazonSpeech \
    && cd /tmp/ReazonSpeech \
    && git checkout ${REAZONSPEECH_REF} \
    && /opt/venv/bin/pip install \
       --no-cache-dir \
       -c /tmp/constraints.txt \
       --extra-index-url https://download.pytorch.org/whl/cu126 \
       /tmp/ReazonSpeech/pkg/espnet-asr \
    && rm -rf /tmp/ReazonSpeech

# ctc-segmentationを実行環境のNumPyに対して再コンパイルする
RUN echo "ASR_PROGRESS:rebuilding-ctc" \
    && /opt/venv/bin/pip uninstall -y ctc-segmentation \
    && /opt/venv/bin/pip install \
       --no-cache-dir \
       --no-build-isolation \
       --no-binary=ctc-segmentation \
       -c /tmp/constraints.txt \
       ctc-segmentation==1.7.4

# 依存整合性チェック + NumPy完全一致検証 + サイズ確認
RUN echo "ASR_PROGRESS:checking-dependencies" \
    && /opt/venv/bin/python -c \
       "import numpy, torch, torchaudio, ctc_segmentation, espnet; \
        assert torch.__version__ == '2.8.0+cu126', f'torch version mismatch: {torch.__version__}'; \
        assert torchaudio.__version__ == '2.8.0+cu126', f'torchaudio version mismatch: {torchaudio.__version__}'; \
        assert torch.version.cuda == '12.6', f'CUDA version mismatch: {torch.version.cuda}'; \
        print(f'numpy={numpy.__version__}, torch={torch.__version__}, ctc_segmentation OK, espnet OK')" \
    && /opt/venv/bin/python -c \
       "from pyannote.audio import Pipeline; print('pyannote OK')" \
    && /opt/venv/bin/pip check \
    && expected_numpy="$(sed -n 's/^numpy==//p' /tmp/constraints.txt)" \
    && actual_numpy="$("/opt/venv/bin/python" -c "import numpy; print(numpy.__version__)")" \
    && test -n "${expected_numpy}" \
    && test "${actual_numpy}" = "${expected_numpy}" \
    && echo "numpy version verified: ${actual_numpy}" \
    && echo "ASR_PROGRESS:verifying-image" \
    && /opt/venv/bin/pip freeze \
    && /opt/venv/bin/pip show torch torchaudio numpy \
    && du -sh /opt/venv \
    && du -sh /opt/venv/lib/python3.11/site-packages/torch \
    && du -sh /opt/venv/lib/python3.11/site-packages/nvidia \
    && du -sh /opt/venv/lib/python3.11/site-packages/triton \
    && test ! -d /opt/venv-asr \
    && test ! -d /opt/venv-diar \
    && rm -rf /root/.cache/pip /tmp/*

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
ENV VENV=/opt/venv

CMD ["/opt/venv/bin/python", "/app/orchestrator.py"]
