const nodemailer = require('nodemailer');
const logger = require('./logger');

let transporter;

const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return transporter;
};

/**
 * Sends an email. Fails "soft" — logs the error but never throws to the
 * caller for non-critical flows (e.g. we don't want registration to fail
 * just because SMTP is briefly down); callers can still await + inspect
 * the return value if they need to know whether it succeeded.
 */
const sendEmail = async ({ to, subject, html, text }) => {
  try {
    const info = await getTransporter().sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      text,
      html,
    });
    logger.info(`Email sent to ${to} — messageId: ${info.messageId}`);
    return true;
  } catch (err) {
    logger.error(`Failed to send email to ${to}: ${err.message}`);
    return false;
  }
};

module.exports = sendEmail;
