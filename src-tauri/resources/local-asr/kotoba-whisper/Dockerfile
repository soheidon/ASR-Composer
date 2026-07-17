FROM asr-composer-base:cu126
LABEL com.asr-composer.engine="kotoba-whisper"
LABEL com.asr-composer.environment-version="1.0.0"
LABEL com.asr-composer.asr-model="kotoba-tech/kotoba-whisper-v2.2"

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TOKENIZERS_PARALLELISM=false \
    TRANSFORMERS_VERBOSITY=error

# ---- 単一venv: torch ----
RUN echo "ASR_PROGRESS:installing-torch" \
    && python3.11 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -U pip setuptools wheel \
    && /opt/venv/bin/pip install \
       --no-cache-dir \
       --index-url https://download.pytorch.org/whl/cu126 \
       torch==2.8.0 torchaudio==2.8.0 \
    && /opt/venv/bin/python -c \
       "import torch, torchaudio; \
        assert torch.__version__ == '2.8.0+cu126'; \
        assert torchaudio.__version__ == '2.8.0+cu126'; \
        print(f'torch={torch.__version__} torchaudio={torchaudio.__version__}')" \
    && rm -rf /root/.cache/pip /tmp/*

# ---- ASR依存（kotoba固有） ----
COPY kotoba-whisper/requirements.txt /tmp/requirements.txt

RUN echo "ASR_PROGRESS:installing-kotoba" \
    && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt \
    && /opt/venv/bin/python -c \
       "import torch, transformers, numpy; \
        assert torch.__version__ == '2.8.0+cu126'; \
        assert transformers.__version__ == '4.56.0'; \
        print(f'torch={torch.__version__} numpy={numpy.__version__} transformers={transformers.__version__}')"

# ---- 最終確認 ----
RUN echo "ASR_PROGRESS:checking-dependencies" \
    && /opt/venv/bin/python -c \
       "import numpy, torch, torchaudio, transformers; \
        assert torch.__version__ == '2.8.0+cu126'; \
        assert torchaudio.__version__ == '2.8.0+cu126'; \
        assert torch.version.cuda == '12.6'; \
        print(f'numpy={numpy.__version__} torch={torch.__version__} OK')" \
    && /opt/venv/bin/python -c \
       "from pyannote.audio import Pipeline; print('pyannote OK')" \
    && /opt/venv/bin/pip check \
    && echo "ASR_PROGRESS:verifying-image" \
    && du -sh /opt/venv \
    && du -sh /opt/venv/lib/python3.11/site-packages/torch \
    && if [ -d /opt/venv/lib/python3.11/site-packages/nvidia ]; then \
         du -sh /opt/venv/lib/python3.11/site-packages/nvidia; \
       fi \
    && if [ -d /opt/venv/lib/python3.11/site-packages/triton ]; then \
         du -sh /opt/venv/lib/python3.11/site-packages/triton; \
       fi \
    && test ! -d /opt/venv-asr \
    && test ! -d /opt/venv-diar \
    && rm -rf /root/.cache/pip /tmp/*

ENV HF_HOME=/work/hf_cache
ENV HUGGINGFACE_HUB_CACHE=/work/hf_cache/hub
ENV TRANSFORMERS_CACHE=/work/hf_cache/transformers
ENV TMPDIR=/work/tmp
ENV TEMP=/work/tmp
ENV TMP=/work/tmp

COPY common/output_writer.py /app/output_writer.py
COPY kotoba-whisper/diar_asr.py /app/diar_asr.py

CMD ["/opt/venv/bin/python", "/app/diar_asr.py"]
