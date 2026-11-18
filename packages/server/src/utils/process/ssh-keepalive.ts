/**
 * The one SSH keepalive of every ssh2 connection this fork opens (remote exec,
 * the log stream, SFTP, setup, the terminals, the remote Docker API).
 *
 * A ping every 15 s, and the connection is dropped after 8 unanswered ones:
 * about two minutes of silence before a host is treated as dead. A build server
 * under heavy load (load 25) answers late, and the old 10 s x 3 setting failed a
 * production deploy with "SSH connection error: Keepalive timeout" while the
 * build was fine. A host that really died is still noticed, a little later.
 *
 * Keep this the only place that spells the numbers: a test fails if another
 * file does, or if a file that opens an ssh2 connection does not use this.
 */
export const SSH_KEEPALIVE = {
	keepaliveInterval: 15_000,
	keepaliveCountMax: 8,
};
