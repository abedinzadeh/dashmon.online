# dashmon.online


## SMS Alerts (Premium)

Dashmon supports Premium-only SMS alerts via Twilio.

Environment variables:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_API_KEY_SID`
- `TWILIO_API_KEY_SECRET`
- `TWILIO_FROM` (E.164 sender number)
- `SMS_TEST_MODE=true` (optional; disables outbound SMS and returns stub responses)

Configure SMS alerts in the dashboard (SMS Alerts button). You can set a default number and optional per-project overrides.
