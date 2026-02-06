const nodemailer = require('nodemailer');

function getSmtpConfig() {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;

  const secureEnv = String(process.env.SMTP_SECURE || '').toLowerCase();
  const secure = secureEnv === 'true' || port === 465;

  return { host, port, user, pass, from, secure };
}

function isSmtpConfigured() {
  const { host, user, pass, from } = getSmtpConfig();
  return Boolean(host && user && pass && from);
}

function createTransporter() {
  const { host, port, user, pass, secure } = getSmtpConfig();

  // We intentionally keep this minimal and compatible with most SMTP providers.
  // STARTTLS is used automatically when secure=false.
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass }
  });
}

async function sendMail({ to, subject, text }) {
  const { from } = getSmtpConfig();
  if (!isSmtpConfigured()) {
    const err = new Error('SMTP not configured');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }
  const transporter = createTransporter();
  return transporter.sendMail({ from, to, subject, text });
}

module.exports = {
  getSmtpConfig,
  isSmtpConfigured,
  sendMail
};
