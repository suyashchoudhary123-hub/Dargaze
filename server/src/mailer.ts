import nodemailer, { type Transporter } from 'nodemailer';
import { config } from './config.js';

let transport: Transporter | null = null;
if (config.smtpUrl) transport = nodemailer.createTransport(config.smtpUrl);
export const mailerConfigured = (): boolean => transport !== null;

export async function sendSecurityEmail(to: string, subject: string, text: string): Promise<void> {
  if (!transport) {
    // Never log one-time links or tokens. Configure SMTP for verification/reset delivery.
    console.warn(`[mail] SMTP is not configured; security email suppressed for ${to.replace(/(^.).*(@.*$)/, '$1***$2')}`);
    return;
  }
  await transport.sendMail({ from: config.emailFrom, to, subject, text });
}
