import InCallManager from 'react-native-incall-manager';

/**
 * Start an in-call audio session.  Activates the audio focus, enables
 * proximity-sensor behaviour so the display dims when the handset is held to
 * the ear, and keeps the screen on throughout the call.
 */
export function startAudioSession() {
  InCallManager.start({ media: 'video' });
  InCallManager.setKeepScreenOn(true);
}

/**
 * Stop the in-call audio session.  Releases audio focus, deactivates the
 * proximity sensor override, and allows the screen to turn off normally.
 */
export function stopAudioSession() {
  InCallManager.setKeepScreenOn(false);
  InCallManager.stop();
}

/**
 * Switch the audio output route between loudspeaker and earpiece.
 *
 * When a Bluetooth audio device is paired and connected, `speakerEnabled=false`
 * will route through Bluetooth rather than the earpiece.
 *
 * @param {boolean} speakerEnabled - `true` to route through the loudspeaker;
 *   `false` to route through the earpiece (or Bluetooth if available).
 */
export function setAudioRoute(speakerEnabled) {
  InCallManager.setForceSpeakerphoneOn(speakerEnabled);
  InCallManager.setSpeakerphoneOn(speakerEnabled);
}
