/**
 * Stub email service for document invitations
 * TODO: Implement actual email sending when SMTP/Gmail credentials are configured
 */

interface InviteEmailParams {
  to: string;
  inviterName: string;
  documentTitle: string;
  acceptUrl: string;
}

export async function sendDocumentInviteEmail(
  params: InviteEmailParams
): Promise<void> {
  console.log(`[EmailService] Document invite email (not sent - no SMTP configured):`);
  console.log(`  To: ${params.to}`);
  console.log(`  From: ${params.inviterName}`);
  console.log(`  Document: ${params.documentTitle}`);
  console.log(`  Accept URL: ${params.acceptUrl}`);
}
