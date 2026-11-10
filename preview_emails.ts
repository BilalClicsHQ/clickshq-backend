// Render every ClicsHQ email template to HTML for design review.
// Run WITHOUT --env-file so no mail credentials are present: the module falls
// back to its console transport and nothing is actually sent.
//
//   EMAIL_PREVIEW_DIR=./email-preview npx tsx preview_emails.ts
import {
  send2FACodeEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendMemberInviteEmail,
  sendSpaceInviteEmail,
  sendMentionNotificationEmail,
  sendDocumentMentionEmail,
  sendTaskAssignedEmail,
  sendTaskStatusChangedEmail,
  sendPaymentFailedEmail,
  sendIntegrationRequestEmail,
} from './server/email';

const TO = 'sara@example.com';

async function main() {
  if (process.env.RESEND_API_KEY || process.env.SMTP_HOST || process.env.GMAIL_USER) {
    console.error('Refusing to run: mail credentials are present, these would be sent for real.');
    process.exit(1);
  }

  await sendVerificationEmail(TO, 'preview-token', 'Sara');
  await sendPasswordResetEmail(TO, 'preview-token', 'Sara');
  await send2FACodeEmail(TO, '742913', 'Sara', 'enable');

  await sendMemberInviteEmail({
    toEmail: TO,
    inviterName: 'Bilal',
    role: 'member',
    inviteLink: 'https://app.clicshq.com/invite/preview',
  });

  await sendSpaceInviteEmail({
    toEmail: TO,
    toName: 'Sara',
    spaceName: 'PRODUCT LAUNCH',
    inviterName: 'Bilal',
    inviteLink: 'https://app.clicshq.com/invite/preview',
    isSoftSignup: true,
  });

  await sendMentionNotificationEmail(
    TO,
    'Sara',
    'Bilal',
    'Design Login Page UI',
    'Website Redesign',
    '@sara can you please update the mockup according to the new brand guidelines?',
    'https://app.clicshq.com/task/preview',
    { age: '2 minutes ago' },
  );

  await sendDocumentMentionEmail({
    toEmail: TO,
    toName: 'Sara',
    mentionedBy: 'Bilal',
    documentName: 'Project Proposal.docx',
    commentContent: '@sara Please review the budget section on page 4 and let me know your thoughts.',
    documentUrl: 'https://app.clicshq.com/doc/preview',
    age: '2 minutes ago',
  });

  await sendTaskAssignedEmail({
    toEmail: TO,
    toName: 'Sara',
    assignedBy: 'Bilal',
    taskName: 'Design Login Page UI',
    taskUrl: 'https://app.clicshq.com/task/preview',
    projectName: 'Website Redesign',
    dueDate: '24 May 2026',
    priority: 'High',
    assigneeName: 'Bilal',
    reporterName: 'Sara',
  });

  await sendTaskStatusChangedEmail({
    toEmail: TO,
    toName: 'Sara',
    changedBy: 'Bilal',
    changedByRole: 'Product manager',
    taskName: 'Design Login Page UI',
    taskUrl: 'https://app.clicshq.com/task/preview',
    previousStatus: 'In Progress',
    newStatus: 'Review',
    changedOn: '18 Jun 2026',
    changedAt: '10:30 AM',
  });

  await sendPaymentFailedEmail({
    toEmail: TO,
    toName: 'Sara',
    planName: 'Team Plan',
    amount: '$49.00',
    date: '18 Jun 2026, 10:30 AM',
    reason: 'Payment Failed',
    updatePaymentUrl: 'https://app.clicshq.com/billing',
  });

  await sendIntegrationRequestEmail({
    toEmail: TO,
    displayName: 'Sara',
    productName: 'Figma',
    priority: 'High',
  });

  console.log('\nAll templates rendered.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
