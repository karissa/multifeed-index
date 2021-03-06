var inherits = require('inherits')
var EventEmitter = require('events').EventEmitter
var State = require('./lib/state')

module.exports = Indexer

var Status = {
  Indexing: 1,
  Ready: 2
}

function Indexer (opts) {
  if (!(this instanceof Indexer)) return new Indexer(opts)

  if (!opts) throw new Error('missing opts param')
  if (!opts.log) throw new Error('missing opts param "log"')
  if (!opts.batch) throw new Error('missing opts param "batch"')
  if (!allOrNone(!!opts.storeState, !!opts.fetchState)) {
    throw new Error('either none or all of (opts.storeState, opts.fetchState) must be provided')
  }
  if (!unset(opts.version) && typeof opts.version !== 'number') throw new Error('opts.version must be a number')
  // TODO: support forward & backward indexing from newest

  this._version = unset(opts.version) ? 1 : opts.version
  this._log = opts.log
  this._batch = opts.batch
  this._maxBatch = unset(opts.maxBatch) ? 50 : opts.maxBatch
  this._state = Status.Indexing

  this._at = null

  if (!opts.storeState && !opts.fetchState && !opts.clearIndex) {
    // In-memory storage implementation
    var state
    this._storeState = function (buf, cb) {
      state = buf
      process.nextTick(cb)
    }
    this._fetchState = function (cb) {
      process.nextTick(cb, null, state)
    }
    this._clearIndex = function (cb) {
      state = null
      process.nextTick(cb)
    }
  } else {
    this._storeState = opts.storeState
    this._fetchState = opts.fetchState
    this._clearIndex = opts.clearIndex || null
  }

  var self = this

  this._log.ready(function () {
    self._fetchState(function (err, state) {
      if (err) {
        self.emit('error', err)
        return
      }
      if (!state) {
        start()
        return
      }

      try {
        state = State.deserialize(state)
      } catch (e) {
        self.emit('error', e)
        return
      }

      // Wipe existing index if versions don't match (and there's a 'clearIndex' implementation)
      var storedVersion = state.version
      if (storedVersion !== self._version && self._clearIndex) {
        self._clearIndex(function (err) {
          if (err) {
            self.emit('error', err)
          } else {
            start()
          }
        })
      } else {
        start()
      }
    })
  })

  function start () {
    self._state = Status.Ready
    self._run()
  }

  this._log.on('feed', function (feed, idx) {
    feed.ready(function () {
      feed.on('append', function () {
        self._run()
      })
      feed.on('download', function () {
        self._run()
      })
      if (self._state === Status.Ready) self._run()
    })
  })

  this.setMaxListeners(128)
}

inherits(Indexer, EventEmitter)

Indexer.prototype.ready = function (fn) {
  if (this._state === Status.Ready) process.nextTick(fn)
  else this.once('ready', fn)
}

Indexer.prototype._run = function () {
  if (this._state !== Status.Ready) return
  var self = this

  this._state = Status.Indexing

  var didWork = false

  var pending = 1

  // load state from storage
  if (!this._at) {
    this._fetchState(function (err, state) {
      if (err) throw err // TODO: how to bubble up errors? eventemitter?
      if (!state) {
        self._at = {}
        self._log.feeds().forEach(function (feed) {
          self._at[feed.key.toString('hex')] = {
            key: feed.key,
            min: 0,
            max: 0
          }
        })
      } else {
        self._at = State.deserialize(state).keys
      }

      self._log.feeds().forEach(function (feed) {
        feed.on('append', function () {
          self._run()
        })
        feed.on('download', function () {
          self._run()
        })
      })

      work()
    })
  } else {
    work()
  }

  function work () {
    var feeds = self._log.feeds()
    var nodes = []

    ;(function collect (i) {
      if (i >= feeds.length) return done()
      var key = feeds[i].key.toString('hex')

      if (self._at[key] === undefined) {
        self._at[key] = { key: feeds[i].key, min: 0, max: 0 }
      }

      // prefer to process forward
      var at = self._at[key].max
      var to = Math.min(feeds[i].length, at + self._maxBatch)

      if (at < to) {
        var toCollect = to - at
        var processed = 0
        var bailed = false
        for (var seq = at; seq < to; seq++) {
          feeds[i].get(seq, {wait: false}, function (seq, err, node) {
            if (bailed) return
            var found = true
            if (err) {
              found = false
              bailed = true
              return collect(i + 1)
            }
            toCollect--
            processed++
            if (found) {
              nodes.push({
                key: feeds[i].key.toString('hex'),
                seq: seq,
                value: node
              })
            }
            if (!toCollect) {
              didWork = true
              self._batch(nodes, function () {
                self._at[key].max += processed
                self._storeState(State.serialize(self._at, self._version), function () {
                  self.emit('indexed', nodes)
                  done()
                })
              })
            }
          }.bind(null, seq))
        }
      } else {
        collect(i + 1)
      }
    })(0)

    function done () {
      if (!--pending) {
        self._state = Status.Ready
        if (didWork) {
          self._run()
        } else {
          self.emit('ready')
        }
      }
    }
  }
}

function allOrNone (a, b) {
  return (!!a && !!b) || (!a && !b)
}

function unset (x) {
  return x === null || x === undefined
}
