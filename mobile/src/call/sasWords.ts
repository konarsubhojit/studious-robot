/**
 * The 256-word vocabulary the call verification code is drawn from.
 *
 * Words rather than digits because the comparison happens *over the call being
 * verified*: a word survives a bad line, a mishearing and an accent far better
 * than a digit does, and "papaya" cannot be confused with "pepper" the way 3
 * can be confused with 8.
 *
 * Exactly 256 entries, so each word encodes one byte of the digest and the
 * mapping needs no modulo bias correction. The list is part of the protocol:
 * changing, reordering or removing a word changes every code, which would read
 * to users as a key change. Additions are equally forbidden — the length is
 * asserted in the tests.
 */
export const SAS_WORDS: readonly string[] = [
  'acorn', 'actor', 'agent', 'album', 'alien', 'alpha', 'amber', 'anchor',
  'angle', 'ankle', 'apple', 'april', 'arena', 'armor', 'arrow', 'artist',
  'aspect', 'atlas', 'attic', 'author', 'autumn', 'avocado', 'awake', 'bacon',
  'badge', 'bagel', 'baker', 'balcony', 'bamboo', 'banjo', 'barrel', 'basil',
  'basket', 'beacon', 'beaver', 'bench', 'berry', 'bicycle', 'bishop', 'bison',
  'blanket', 'blossom', 'bobcat', 'bonus', 'border', 'bottle', 'boulder', 'bracket',
  'branch', 'bridge', 'bronze', 'brush', 'bubble', 'bucket', 'buffalo', 'bundle',
  'bunker', 'burger', 'butler', 'button', 'cabin', 'cactus', 'camel', 'candle',
  'canvas', 'canyon', 'carbon', 'cargo', 'carpet', 'carrot', 'castle', 'cavern',
  'cedar', 'cello', 'cement', 'census', 'chapel', 'cherry', 'chimney', 'cinema',
  'circus', 'clover', 'cobra', 'cocoa', 'coffee', 'collar', 'comet', 'compass',
  'copper', 'coral', 'cotton', 'cougar', 'cousin', 'cowboy', 'crater', 'cricket',
  'crystal', 'cupcake', 'curtain', 'cushion', 'cymbal', 'dagger', 'dahlia', 'dancer',
  'delta', 'denim', 'dentist', 'desert', 'diamond', 'diesel', 'dinner', 'dolphin',
  'domino', 'donkey', 'dragon', 'drummer', 'eagle', 'eclipse', 'elbow', 'elder',
  'elephant', 'elmwood', 'ember', 'emerald', 'engine', 'envelope', 'escort', 'fabric',
  'falcon', 'farmer', 'feather', 'fender', 'ferry', 'fiddle', 'finger', 'flamingo',
  'flannel', 'flask', 'flute', 'forest', 'fossil', 'fountain', 'fragment', 'freezer',
  'frost', 'galaxy', 'gallery', 'garlic', 'gazelle', 'gecko', 'ginger', 'glacier',
  'glider', 'granite', 'grape', 'gravel', 'guitar', 'hamlet', 'hammer', 'hamster',
  'harbor', 'harvest', 'hazel', 'helmet', 'heron', 'hickory', 'hollow', 'honey',
  'hornet', 'hostel', 'hubcap', 'hunter', 'iceberg', 'igloo', 'impala', 'indigo',
  'insect', 'island', 'ivory', 'jacket', 'jaguar', 'jasmine', 'jersey', 'jigsaw',
  'jockey', 'journal', 'juniper', 'kayak', 'kettle', 'kitten', 'koala', 'ladder',
  'lagoon', 'lantern', 'laptop', 'lasso', 'laundry', 'lemon', 'leopard', 'lettuce',
  'lilac', 'lobster', 'locket', 'lumber', 'magnet', 'mailbox', 'mammoth', 'mandolin',
  'mango', 'maple', 'marble', 'marina', 'market', 'meadow', 'melon', 'meteor',
  'mimosa', 'mirror', 'mitten', 'monkey', 'moose', 'mosaic', 'muffin', 'mustard',
  'napkin', 'nectar', 'needle', 'nickel', 'nutmeg', 'oatmeal', 'observer', 'octopus',
  'olive', 'onion', 'orbit', 'orchard', 'ostrich', 'otter', 'oxygen', 'oyster',
  'paddle', 'palace', 'pancake', 'panther', 'papaya', 'parrot', 'pasta', 'peanut',
  'pebble', 'pelican', 'pepper', 'phantom', 'piano', 'pigeon', 'pilot', 'pirate',
];
