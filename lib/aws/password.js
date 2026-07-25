// Shared password policy (signup + reset must agree, or one becomes a bypass).
const MIN = Number(process.env.PASSWORD_MIN_LENGTH || 10);

// Small list of passwords that meet the length rule but are guessed first.
const COMMON = new Set([
  "password1!", "password123", "passw0rd123", "welcome123", "qwerty12345",
  "letmein1234", "admin12345", "changeme123", "ajace12345", "timesheet1",
  "iloveyou123", "1234567890", "0123456789", "abcd123456",
]);

/** @returns {string|null} an error message, or null when acceptable */
export function passwordProblem(pw) {
  if (typeof pw !== "string" || pw.length < MIN) {
    return `Password must be at least ${MIN} characters.`;
  }
  if (pw.length > 200) return "Password must be under 200 characters.";
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) return "That password is too easy to guess. Choose something less common.";
  if (/^(.)\1+$/.test(pw)) return "Password can't be a single repeated character.";
  if (/^(0123456789|1234567890|abcdefghij)/.test(lower)) return "Password can't be a simple sequence.";
  return null;
}

export const PASSWORD_MIN_LENGTH = MIN;
