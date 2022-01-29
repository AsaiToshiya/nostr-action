"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.relayPool = relayPool;

var _event = require("./event");

var _relay = require("./relay");

function relayPool() {
  var globalPrivateKey;
  var globalSigningFunction;
  const poolPolicy = {
    // setting this to a number will cause events to be published to a random
    // set of relays only, instead of publishing to all relays all the time
    randomChoice: null,
    // setting this to true will cause .publish() calls to wait until the event has
    // been published -- or at least attempted to be published -- to all relays
    wait: false
  };
  const relays = {};
  const noticeCallbacks = [];

  function propagateNotice(notice, relayURL) {
    for (let i = 0; i < noticeCallbacks.length; i++) {
      let {
        relay
      } = relays[relayURL];
      noticeCallbacks[i](notice, relay);
    }
  }

  const activeSubscriptions = {};

  const sub = ({
    cb,
    filter
  }, id = Math.random().toString().slice(2)) => {
    const subControllers = Object.fromEntries(Object.values(relays).filter(({
      policy
    }) => policy.read).map(({
      relay
    }) => [relay.url, relay.sub({
      filter,
      cb: event => cb(event, relay.url)
    }, id)]));
    const activeCallback = cb;
    const activeFilters = filter;

    const unsub = () => {
      Object.values(subControllers).forEach(sub => sub.unsub());
      delete activeSubscriptions[id];
    };

    const sub = ({
      cb = activeCallback,
      filter = activeFilters
    }) => {
      Object.entries(subControllers).map(([relayURL, sub]) => [relayURL, sub.sub({
        cb,
        filter
      }, id)]);
      return activeSubscriptions[id];
    };

    const addRelay = relay => {
      subControllers[relay.url] = relay.sub({
        cb,
        filter
      }, id);
      return activeSubscriptions[id];
    };

    const removeRelay = relayURL => {
      if (relayURL in subControllers) {
        subControllers[relayURL].unsub();
        if (Object.keys(subControllers).length === 0) unsub();
      }

      return activeSubscriptions[id];
    };

    activeSubscriptions[id] = {
      sub,
      unsub,
      addRelay,
      removeRelay
    };
    return activeSubscriptions[id];
  };

  return {
    sub,
    relays,

    setPrivateKey(privateKey) {
      globalPrivateKey = privateKey;
    },

    registerSigningFunction(fn) {
      globalSigningFunction = fn;
    },

    setPolicy(key, value) {
      poolPolicy[key] = value;
    },

    addRelay(url, policy = {
      read: true,
      write: true
    }) {
      let relayURL = (0, _relay.normalizeRelayURL)(url);
      if (relayURL in relays) return;
      let relay = (0, _relay.relayConnect)(url, notice => {
        propagateNotice(notice, relayURL);
      });
      relays[relayURL] = {
        relay,
        policy
      };

      if (policy.read) {
        Object.values(activeSubscriptions).forEach(subscription => subscription.addRelay(relay));
      }

      return relay;
    },

    removeRelay(url) {
      let relayURL = (0, _relay.normalizeRelayURL)(url);
      let data = relays[relayURL];
      if (!data) return;
      let {
        relay
      } = data;
      Object.values(activeSubscriptions).forEach(subscription => subscription.removeRelay(relay));
      relay.close();
      delete relays[relayURL];
    },

    onNotice(cb) {
      noticeCallbacks.push(cb);
    },

    offNotice(cb) {
      let index = noticeCallbacks.indexOf(cb);
      if (index !== -1) noticeCallbacks.splice(index, 1);
    },

    async publish(event, statusCallback) {
      event.id = (0, _event.getEventHash)(event);

      if (!event.sig) {
        event.tags = event.tags || [];

        if (globalPrivateKey) {
          event.sig = await (0, _event.signEvent)(event, globalPrivateKey);
        } else if (globalSigningFunction) {
          event.sig = await globalSigningFunction(event);

          if (!event.sig) {
            // abort here
            return;
          } else {
            // check
            if (!(await (0, _event.verifySignature)(event))) throw new Error('signature provided by custom signing function is invalid.');
          }
        } else {
          throw new Error("can't publish unsigned event. either sign this event beforehand, provide a signing function or pass a private key while initializing this relay pool so it can be signed automatically.");
        }
      }

      let writeable = Object.values(relays).filter(({
        policy
      }) => policy.write).sort(() => Math.random() - 0.5); // random

      let maxTargets = poolPolicy.randomChoice ? poolPolicy.randomChoice : writeable.length;
      let successes = 0;

      if (poolPolicy.wait) {
        for (let i = 0; i < writeable.length; i++) {
          let {
            relay
          } = writeable[i];

          try {
            await new Promise(async (resolve, reject) => {
              try {
                await relay.publish(event, status => {
                  if (statusCallback) statusCallback(status, relay.url);
                  resolve();
                });
              } catch (err) {
                if (statusCallback) statusCallback(-1, relay.url);
              }
            });
            successes++;

            if (successes >= maxTargets) {
              break;
            }
          } catch (err) {
            /***/
          }
        }
      } else {
        writeable.forEach(async ({
          relay
        }) => {
          let callback = statusCallback ? status => statusCallback(status, relay.url) : null;
          relay.publish(event, callback);
        });
      }

      return event;
    }

  };
}