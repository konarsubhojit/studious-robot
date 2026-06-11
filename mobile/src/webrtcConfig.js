const GOOGLE_STUN_URL = 'stun:stun.l.google.com:19302';

function readEnv(name) {
  const env = globalThis?.process?.env;
  return env?.[name];
}

export function getIceServers() {
  const turnUsername = readEnv('TURN_USERNAME');
  const turnCredential = readEnv('TURN_CREDENTIAL');
  const iceServers = [{ urls: [GOOGLE_STUN_URL] }];

  if (turnUsername && turnCredential) {
    iceServers.push({
      urls: [
        'turn:global.relay.metered.ca:80',
        'turn:global.relay.metered.ca:80?transport=tcp',
        'turn:global.relay.metered.ca:443',
        'turns:global.relay.metered.ca:443?transport=tcp',
      ],
      username: turnUsername,
      credential: turnCredential,
    });
  }

  return iceServers;
}
