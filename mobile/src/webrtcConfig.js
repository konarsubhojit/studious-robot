const GOOGLE_STUN_URL = 'stun:stun.l.google.com:19302';
const METERED_DEFAULT_USERNAME = 'openrelayproject';
const METERED_DEFAULT_CREDENTIAL = 'openrelayproject';

export function getIceServers() {
  const turnUsername = process.env?.['EXPO_PUBLIC_TURN_USERNAME'] || METERED_DEFAULT_USERNAME;
  const turnCredential = process.env?.['EXPO_PUBLIC_TURN_CREDENTIAL'] || METERED_DEFAULT_CREDENTIAL;

  return [
    { urls: [GOOGLE_STUN_URL] },
    {
      urls: [
        'turn:global.relay.metered.ca:80',
        'turn:global.relay.metered.ca:80?transport=tcp',
        'turn:global.relay.metered.ca:443',
        'turns:global.relay.metered.ca:443?transport=tcp',
      ],
      username: turnUsername,
      credential: turnCredential,
    },
  ];
}
