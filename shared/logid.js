// Log identities and the streamed client log (SPEC §13.5), shared by the server and the browser.
//
// Every browser gets a random word id like `amber-otter` (an adjective and a noun from the lists
// below): the server hands it out on connect, the client keeps it in localStorage and offers it
// again on the next connect, and the server accepts an offered id only if it is a valid pair from
// these lists. The word is shown small in the lobby so a player can quote it; the admin finds that
// player's last hour of client log by word, name or IP.
const ADJ = ('amber azure bold brave brisk bronze calm candid cheery clever cobalt cosmic coral crimson crisp ' +
  'daring dusky eager early easy fancy fast fierce fluffy frosty gentle giant gilded glad golden grand ' +
  'happy hasty hazel humble icy indigo jade jolly keen kind lemon lively lone lucky lunar maple merry ' +
  'misty modest mossy neat nimble noble olive orange pastel peppy plucky polar proud quick quiet rapid ' +
  'rosy ruby rustic sandy scarlet shiny silent silver sleek sly smooth snowy solar spicy steady stormy ' +
  'sunny swift tame tidy tiny topaz vivid warm wild windy witty young zany zesty agile breezy dapper fuzzy mellow rugged').split(' ');
const NOUN = ('badger beaver bison bobcat camel cobra condor cougar coyote crane crow deer dingo dolphin dove ' +
  'eagle eel falcon ferret finch fox gecko gibbon goose gopher heron hippo hornet husky ibex iguana ' +
  'jackal jaguar koala lemur leopard lion llama lobster lynx magpie marmot mink mole moose moth newt ' +
  'ocelot octopus orca osprey otter owl panda panther parrot pelican penguin pigeon puffin puma python ' +
  'quail rabbit raven robin salmon seal shark sloth snail sparrow spider squid stork swan tapir tiger ' +
  'toad toucan trout turtle viper vulture walrus weasel whale wolf wombat yak zebra alpaca bear cat duck frog hawk mouse pony wren').split(' ');
export const WORDS = Object.freeze({ adj: Object.freeze(ADJ), noun: Object.freeze(NOUN) });
const ADJ_SET = new Set(ADJ), NOUN_SET = new Set(NOUN);
export const WORD_ID_COUNT = ADJ.length * NOUN.length;

// A valid id is exactly `<adjective>-<noun>` from the lists (lower case, nothing else).
export function isWordId(s) {
  if (typeof s !== 'string' || s.length > 40) return false;
  const m = /^([a-z]+)-([a-z]+)$/.exec(s);
  return !!m && ADJ_SET.has(m[1]) && NOUN_SET.has(m[2]);
}
// rand: () => [0, 1), required (shared/ stays free of Math.random): the server passes a crypto-backed one.
export function randomWordId(rand) {
  const pick = a => a[Math.min(a.length - 1, Math.floor(rand() * a.length))];
  return `${pick(ADJ)}-${pick(NOUN)}`;
}

// The streamed client log: {t:'log', e:[entry…], lost?} over the game WebSocket. The client packs
// entries into messages of at most msgBytes (the server's maxPayload is 1 KiB) and maxEntries each,
// flushes every flushMs and when the tab is hidden or closed, and keeps at most queueMax unsent
// entries (older ones are dropped and reported as `lost`). The server allows `burst` log messages
// at once and `perSec` after that, per connection; excess is dropped and counts toward the flood kick.
export const LOG = Object.freeze({
  msgBytes: 1000, maxEntries: 20, flushMs: 4000, perFlush: 3, queueMax: 200,
  burst: 6, perSec: 1, strMax: 300,
  keepMs: 60 * 60 * 1000,          // the server keeps one hour per identity
  // Fast, repetitive entries are thinned before streaming (they stay in the local ring): at most
  // one per this many ms for `cat msg`.
  thin: { 'sync rtt': 5000, 'perf slow frame': 1000 },
});
