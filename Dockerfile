FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 STATE_DIR=/var/lib/margaret
WORKDIR /app
COPY requirements.txt .
RUN python -m pip install --no-cache-dir -r requirements.txt \
    && useradd --system --uid 10001 --no-create-home agent \
    && install -d -o agent -g agent -m 0700 /var/lib/margaret \
    && touch /var/lib/margaret/.keep \
    && chown agent:agent /var/lib/margaret/.keep
COPY agent.py settings.py limits.py memory.py transcripts.py ./
COPY personas/ ./personas/
USER agent
CMD ["python", "agent.py", "start"]
