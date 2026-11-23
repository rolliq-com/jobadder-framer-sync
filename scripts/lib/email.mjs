// The email to JobAdder support that setup prints at the end. Pure function:
// it is never given the password, so the password cannot end up in an email
// thread that copies other people.

export const JOBADDER_SUPPORT = "support@jobadder.com";

/** @param {string} board */
export function checkBoard(board) {
  if (!/^[A-Za-z0-9-]{1,32}$/.test(board)) throw new Error(`"${board}" is not a JobAdder board number.`);
  return board;
}

/**
 * @param {{ url: string, username?: string, board?: string, rotated?: boolean }} details
 */
export function jobadderEmail({ url, username, board, rotated = false }) {
  const boardId = board ? checkBoard(board) : "<BOARD_ID>";
  const user = username || "<USERNAME>";
  const subject = rotated
    ? `New login for the XML job feed push, board ${boardId}`
    : `Please set up the XML job feed push for board ${boardId}`;
  const after = rotated
    ? "Please reply when it is updated."
    : "Please reply when it is enabled. The client's account owner will then post or edit an ad\non the board so the first push goes through.";
  const ask = rotated
    ? `We have changed the login for the XML job feed push on job board ${boardId}. Please update\nthe feed to use the username below. Everything else is unchanged:`
    : `Please set job board ${boardId} to push its XML job feed to our endpoint:`;
  return `To:       ${JOBADDER_SUPPORT}
Cc:       the client's JobAdder account owner (to authorise; they can reply "approved")
Subject:  ${subject}

Hello JobAdder support,

${ask}

  Method:    HTTP POST, raw XML in the request body (not form-encoded)
  URL:       ${url}
  Auth:      HTTP basic auth
  Username:  ${user}
  Password:  sent separately to the agent who picks this up, not in this email

${after}

Thank you`;
}
