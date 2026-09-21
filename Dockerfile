FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY baby.py .
COPY reminder.py .
COPY storage.py .
COPY food_library.py .
COPY food_entries.py .
COPY food_screening.py .
COPY templates/ templates/
COPY static/ static/

# Expose port
EXPOSE 8888

# Run
CMD ["gunicorn", "--bind", "0.0.0.0:8888", "--workers", "2", "--threads", "4", "--timeout", "120", "baby:app"]
