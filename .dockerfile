FROM python:3.11-slim
RUN apt-get update && apt-get install -y g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir fastapi uvicorn pandas numpy scipy pydantic
CMD uvicorn api.main:app --host 0.0.0.0 --port ${PORT:-8000}
