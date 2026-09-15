{
  "version": 1,
  "auth_id": "openai-compatibility:mock-openai:484455246a84",
  "provider": "openai-compatible-mock-openai",
  "updated_at": "2026-09-15T17:26:54.835355011Z",
  "records": [
    {
      "provider": "openai-compatible-mock-openai",
      "auth_id": "openai-compatibility:mock-openai:484455246a84",
      "status": "cooling",
      "next_retry_after": "2026-09-16T01:27:24.835269345+08:00",
      "reason": "{\"error\": {\"message\": \"mock rate limit\", \"type\": \"rate_limit_exceeded\", \"code\": \"rate_limit_exceeded\"}}",
      "quota": {
        "exceeded": false,
        "next_recover_at": "0001-01-01T00:00:00Z",
        "observed_at": "0001-01-01T00:00:00Z"
      },
      "last_error": {
        "message": "{\"error\": {\"message\": \"mock rate limit\", \"type\": \"rate_limit_exceeded\", \"code\": \"rate_limit_exceeded\"}}",
        "retryable": false,
        "http_status": 500
      },
      "updated_at": "2026-09-16T01:26:54.835269345+08:00"
    },
    {
      "provider": "openai-compatible-mock-openai",
      "auth_id": "openai-compatibility:mock-openai:484455246a84",
      "model": "mock-model",
      "status": "cooling",
      "next_retry_after": "2026-09-16T01:27:24.835269345+08:00",
      "reason": "{\"error\": {\"message\": \"mock rate limit\", \"type\": \"rate_limit_exceeded\", \"code\": \"rate_limit_exceeded\"}}",
      "quota": {
        "exceeded": false,
        "next_recover_at": "0001-01-01T00:00:00Z",
        "observed_at": "0001-01-01T00:00:00Z"
      },
      "last_error": {
        "message": "{\"error\": {\"message\": \"mock rate limit\", \"type\": \"rate_limit_exceeded\", \"code\": \"rate_limit_exceeded\"}}",
        "retryable": false,
        "http_status": 500
      },
      "updated_at": "2026-09-16T01:26:54.835269345+08:00"
    }
  ]
}
