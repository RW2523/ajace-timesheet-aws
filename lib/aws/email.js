// Transactional email via Amazon SES. Credentials come from the EC2 instance
// IAM role (needs ses:SendEmail). If SES_FROM_EMAIL isn't set, emailEnabled()
// is false and callers fall back to logging the link (dev / not-yet-configured).
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const REGION = process.env.SES_REGION || process.env.STORAGE_S3_REGION || "us-east-1";
const FROM = process.env.SES_FROM_EMAIL; // must be a VERIFIED SES identity

let _ses;
const ses = () => (_ses ||= new SESClient({ region: REGION }));

export const emailEnabled = () => !!FROM;

export async function sendPasswordReset(to, link) {
  if (!FROM) return { sent: false, reason: "SES_FROM_EMAIL not set" };
  await ses().send(
    new SendEmailCommand({
      Source: FROM,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: "Reset your Ajace Timesheets password" },
        Body: {
          Text: { Data: `Reset your password using the link below (valid for 1 hour):\n\n${link}\n\nIf you didn't request this, you can ignore this email.` },
          Html: { Data:
            `<p>Reset your <b>Ajace Timesheets</b> password using the link below (valid for 1 hour):</p>` +
            `<p><a href="${link}">${link}</a></p>` +
            `<p style="color:#666;font-size:13px">If you didn't request this, you can safely ignore this email.</p>` },
        },
      },
    })
  );
  return { sent: true };
}
