// External notification providers. None is integrated yet (email is deferred by
// decision, push awaits a provider). The worker retries rows until one exists.
export async function sendPush(_notification) {
  throw new Error('PUSH_PROVIDER_NOT_CONFIGURED');
}
export async function sendEmail(_notification) {
  throw new Error('EMAIL_PROVIDER_NOT_CONFIGURED');
}
