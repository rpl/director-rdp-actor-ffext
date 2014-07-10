/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const { classes: Cc, interfaces: Ci, utils: Cu, results: Cr } = Components;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

/**
 * `osString` specifies the current operating system.
 * Go to https://developer.mozilla.org/docs/XPCOM_Interface_Reference/nsIXULRuntime
 * for more information.
 */
XPCOMUtils.defineLazyGetter(this, "osString", () =>
  Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULRuntime).OS);

const { devtools } = Cu.import("resource://gre/modules/devtools/Loader.jsm", {});
const require = devtools.require;

XPCOMUtils.defineLazyGetter(this, 'DebuggerServer', function() {
  Cu.import('resource://gre/modules/devtools/dbg-server.jsm');
  return DebuggerServer;
});

// const {Cc, Ci, Cu, Cr, CC} = require("chrome");
const events = require("sdk/event/core");
const { Class } = require("sdk/core/heritage");
const protocol = require("devtools/server/protocol");
const { ContentObserver } = require("devtools/content-observer");
const { getInnerId } = require('sdk/window/utils');
const { create, descriptor } = require('toolkit/loader');

const { addContentGlobal } = require("devtools/server/content-globals");

var console = {
  log: (...args) => {
     dump(args.map((e) => e.toString()).join(" "));
  }
};

function evaluate(sandbox, code, uri, line, version) {
  return Cu.evalInSandbox(code, sandbox, version || '1.8', uri || '', line || 1);
}

function sandbox(target, options) {
  options = options || {};
  options.metadata = options.metadata ? options.metadata : {};
  options.metadata.addonID = options.metadata.addonID ?
    options.metadata.addonID : "prova";

  let sandbox = Cu.Sandbox(target, options);
  Cu.setSandboxMetadata(sandbox, options.metadata);
  let innerWindowID = options.metadata['inner-window-id']
  if (innerWindowID) {
    addContentGlobal({
      global: sandbox,
      'inner-window-id': innerWindowID
    });
  }
  return sandbox;
}

var { EventTarget } = require("sdk/event/target");

// TODO: it would be nice to be exported
//const { WebConsoleActor } = require("devtools/server/actors/webconsole");

const { on, once, off, emit } = events;
const { method, Arg, Option, RetVal } = protocol;

let exports = {};

let InstrumenterActor = protocol.ActorClass({
  typeName: "instrumenter",
  initialize: function(conn, tabActor, id, source, options) {
    protocol.Actor.prototype.initialize.call(this, conn);
    this._id = id;
    this._conn = conn;
    this._tabActor = tabActor;
    this._source = source;
    this._options = options;

    this._onGlobalCreated = this._onGlobalCreated.bind(this);
    this._onGlobalDestroyed = this._onGlobalDestroyed.bind(this);

    this._contentObserver = new ContentObserver(this._tabActor);

    on(this._contentObserver, "global-created", this._onGlobalCreated);
    on(this._contentObserver, "global-destroyed", this._onGlobalDestroyed);

    this._consoleActor = new (tabActor._extraActors.consoleActor)(conn, this);
  },
  destroy: function(conn) {
    protocol.Actor.prototype.destroy.call(this, conn);
    this.finalize();
  },
  activate: method(function(reload) {
    this._createSandbox();

    this._contentObserver.startListening();

    if (reload) {
      this._tabActor.window.location.reload();
    }
  }, {
    oneway: true,
    request: {
      reload: Arg(0, "boolean")
    }
  }),

  deactivate: method(function(reload) {
    this._contentObserver.stopListening();

    if (this._sandboxModule && this._sandboxModule.exports.onUnload) {
        this._sandboxModule.exports.onUnload.call(null);
    }
    Cu.nukeSandbox(this._sandbox);

    if (reload) {
      this._tabActor.window.location.reload();
    }
  }, {
    oneway: true,
    request: {
      reload: Arg(0, "boolean")
    }
  }),

  finalize: method(function() {
    off(this._contentObserver, "global-created", this._onGlobalCreated);
    off(this._contentObserver, "global-destroyed", this._onGlobalDestroyed);

    if (this._sandboxModule && this._sandboxModule.exports.onUnload) {
        this._sandboxModule.exports.onUnload.call(null);
    }
    Cu.nukeSandbox(this._sandbox);
  }, {
    oneway: true
  }),

  sendEvent: method(function(name, data) {
    console.log("SEND EVENT", name, data);
    if (this._sandboxModule.exports.onEvent) {
        try {
          this._sandboxModule.exports.onEvent.call(null, name,
                                                   Cu.cloneInto(data, this._sandbox));
        } catch (e) {
            console.log("SEND EVENT EXCEPTION", e);
        }
    }
  }, {
    oneway: true,
    request: {
      name: Arg(0, "string"),
      data: Arg(1, "nullable:json")
    }
  }),

  callMethod: method(function(name, args) {
    let sandboxExportedMethod = this._sandboxModule.exports[name];

    if (sandboxExportedMethod) {
      return sandboxExportedMethod.apply(null, Cu.cloneInto(args, this._sandbox));
    }

    return null;
  }, {
    request: {
      name: Arg(0, "string"),
      args: Arg(1, "array:json")
    },
    response: {
      data: RetVal("nullable:json")
    }
  }),

  events: {
    "instrumenter-event": {
      type: "instrumenterEvent",
      data: Arg(0, "nullable:json")
    },
  },

  _createSandbox: function() {
    let window = this._tabActor.window;
    // Create the sandbox and bind it to window in order for content scripts to
    // have access to all standard globals (window, document, ...)
    this._sandbox = sandbox(window, {
      sandboxName: this._id,
      wantXrays: true,
      wantComponents: false,
      // TODO: export helpers could be useful
      wantExportHelpers: false,
      // TODO: to be checkedcheck
      sameZoneAs: window,
      metadata: {
        SDKInstrumenterScript: true,
        "inner-window-id": getInnerId(window)
      }
    });

    // create commonjs-style exports
    var sandboxModule = this._sandboxModule = Cu.createObjectIn(this._sandbox, { defineAs: "module" });
    var exports = Cu.createObjectIn(this._sandbox, { defineAs: "exports" });
    sandboxModule.exports = exports;

    // create instrumenter sandbox API
    var sandboxInstrumenter = Cu.createObjectIn(this._sandbox, { defineAs: "instrumenter" });

    // expose instrumenter.options
    sandboxInstrumenter.options = Cu.cloneInto(this._options, this._sandbox);

    // expose instrumenter.emit
    Cu.exportFunction((name, data) => {
      emit(this, "instrumenter-event", { name: name, data: data });
    }, sandboxInstrumenter, { defineAs: "emit" });

    // expose instrumenter.target
    var sandboxTarget = this._sandboxTarget = Cu.createObjectIn(sandboxInstrumenter,
                                                                { defineAs: "target" });

    // expose instrumenter.target.window
    sandboxTarget.window = window;

    // expose instrumenter.target.document
    sandboxTarget.document = window.document;

    // expose instrumenter.target.evaluate
    Cu.exportFunction((source) => {
      if (!source) {
        throw Error("source is undefined");
      }

      return this._consoleActor.onEvaluateJS({
         bindObjectActor: null,
         frameActor: null,
         // TODO: check if we ca put the caller line number as url
         url: "instrumenter@" + this.actorID,
         text: source
      });
    }, sandboxTarget, { defineAs: "evaluate" });

    // TODO: remove this hack for a better console object injection method
    var con = Cu.createObjectIn(this._sandbox, { defineAs: "console" });
    Cu.exportFunction(function log(...args) { console.log.apply(console, args); },
                      con, { defineAs: "log" });

    // evaluate the configured instrumenter source in the sandbox
    evaluate(this._sandbox, this._source);
    console.log("EXPORTS", sandboxModule.exports);
  },

  _onGlobalCreated: function(window) {
    // filter inspected tab window from created windows
    if (this._tabActor.window !== window) {
      return;
    }

    // save window id (needed to be checked onGlobalDestroy)
    this._watchingWindowId = getInnerId(window);

    console.log("GLOBAL CREATED");
    this.activate();

    if (this._sandboxModule.exports.onGlobalCreated) {
      this._sandboxModule.exports.onGlobalCreated.call(null);
    }
  },

  _onGlobalDestroyed: function(id) {
    // filter inspected tab window from created windows
    if (this._watchingWindowId !== id) {
      return;
    }

    delete this._watchingWindowId;

    console.log("GLOBAL DESTROYED");
    delete this._sandboxTarget.window;
    delete this._sandboxTarget.document;

    if (this._sandboxModule.exports.onGlobalDestroyed) {
      this._sandboxModule.exports.onGlobalDestroyed.call(null);
    }

    this.deactivate();
  }
});

let InstrumenterFront = protocol.FrontClass(InstrumenterActor, {
  initialize: function(client, form) {
    protocol.Front.prototype.initialize.call(this, client, form);
  }
});

exports.InstrumenterFront = InstrumenterFront;

let DirectorActor = protocol.ActorClass({
  typeName: "director",
  initialize: function(conn, tabActor) {
    protocol.Actor.prototype.initialize.call(this, conn);
    this._conn = conn;
    this._tabActor = tabActor;
    this._instrumenters = new Map();
  },
  destroy: function(conn) {
    protocol.Actor.prototype.destroy.call(this, conn);
    this.finalize(); // TODO: to be defined
  },

  /* install a new instrumenter given an id, source and options */
  install: method(function(id, source, options) {
    // TODO: check instrumenterConfig.id exists and is unique
    let instrumenter = new InstrumenterActor(this._conn, this._tabActor, id, source, options);
    this._instrumenters.set(id, instrumenter);

    return instrumenter;
  }, {
    request: {
      id: Arg(0, "nullable:string"),
      source: Arg(1, "string"),
      options: Arg(2, "nullable:json")
    },
    response: { instrumenter: RetVal("instrumenter") }
  }),

  /* uninstall an instrumenter given its id */
  uninstall: method(function (id) {
    let instrumenter = this._instrumenters.get(id);

    if (!instrumenter) {
      throw "instrumenter not found: " + id;
    }

    this._instrumenters.delete(id);
    instrumenter.destroy();
  }, {
    request: {
      id: Arg(0, "string")
    },
    response: { }
  }),

  /* list installed instrumenter */
  list: method(function () {
    return this._instrumenters.values();
  }, {
    response: {
      instrumenters: RetVal("array:instrumenter")
    }
  }),

  finalize: method(function() {
    // TODO
  }, {
    oneway: true
  })
});

exports.DirectorActor = DirectorActor;

exports.DirectorFront = protocol.FrontClass(DirectorActor, {
  initialize: function(client, { directorActor }) {
    protocol.Front.prototype.initialize.call(this, client, {
      actor: directorActor
    });
    client.addActorPool(this);
    this.manage(this);
  }
});

/**
 * Called when the extension needs to start itself up. This happens at
 * application launch time or when the extension is enabled after being
 * disabled (or after it has been shut down in order to install an update.
 * As such, this can be called many times during the lifetime of the application.
 *
 * This is when your add-on should inject its UI, start up any tasks it may
 * need running, and so forth.
 *
 * Go to https://developer.mozilla.org/Add-ons/Bootstrapped_extensions
 * for more information.
 */
function startup() {
  dump("************************* startup\n")
  try {
    DebuggerServer.addTabActor(DirectorActor, "directorActor");
      dump("************************* DIRECTOR ACTOR added\n")
  } catch(e) {
      dump("************************* startup exception: "+ e +"\n")
  }
}

/**
 * Called when the extension needs to shut itself down, such as when the
 * application is quitting or when the extension is about to be upgraded or
 * disabled. Any user interface that has been injected must be removed, tasks
 * shut down, and objects disposed of.
 */
function shutdown() {
  DebuggerServer.removeTabActor(DirectorActor);
  Services.obs.notifyObservers(null, "startupcache-invalidate", null);
}

/**
 * Called before the first call to startup() after the extension is installed,
 * upgraded, or downgraded.
 */
function install() {
  dump("************************* install\n")
  /*try {
    DebuggerServer.addTabActor(DirectorActor, "directorActor");
  } catch(e) {
      dump("************************* startup exception: "+ e +"\n")
  }*/
}

/**
 * This function is called after the last call to shutdown() before a particular
 * version of an extension is uninstalled. This will not be called if install()
 * was never called.
 */
function uninstall() {
}

dump("LOADED\n");
