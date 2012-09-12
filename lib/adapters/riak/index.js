var model = require('../../index')
  , utils = require('utilities')
  , operation = require('../../query/operation')
  , comparison = require('../../query/comparison')
  , datatypes = require('../../datatypes')
  , request = utils.request
  , BaseAdapter = require('../base_adapter').BaseAdapter
  , _baseConfig
  , _reduceFunction
  , _mapReduceQuery
  , _bucketizeModelName
  , _serializeForDataType;

_baseConfig = {
  protocol: 'http'
, host: 'localhost'
, port: 8098
};

var Adapter = function (options) {
  var opts = options || {}
    , config;

  this.name = 'riak';
  this.config = _baseConfig;
  this.client = null;

  utils.mixin(this.config, opts);

  this.init.apply(this, arguments);
};

Adapter.prototype = new BaseAdapter();
Adapter.prototype.constructor = Adapter;

_bucketizeModelName = function (name) {
  var bucketName = utils.inflection.pluralize(name);
  bucketName = utils.string.snakeize(bucketName);
  return bucketName;
};

// This function is special -- its source is transformed into
// a JSON-safe string and posted as the reduce-sort to Riak
_reduceFunction = function (values, arg) {
  // Dummy value to replace with real sort data -- will look
  // like {'foo': 'asc', 'bar': 'desc'}
  var sort = '__sort__'
  // Directional sort, returns explicit zero if equal
    , baseSort = function (a, b, dir) {
      if (a == b) {
        return 0;
      }
      if (dir == 'asc') {
        return a > b ? 1 : -1;
      }
      else {
        return a > b ? -1 : 1;
      }
    }
  // Iterates each of the sort columns until it finds a
  // pair of values that are not the same
  , columnSort = function (a, b) {
      var ret;
      for (var p in sort) {
        // Call the directional sort for the two values
        // in this property
        ret = baseSort(a[p], b[p], sort[p]);
        // -1 and 1 are truthy
        if (ret) {
          return ret;
        }
      }
      return 1;
    };
  return values.sort(columnSort);
};

_mapReduceQuery = function (bucket, conditions, sort) {
  var reduce = ''
    , reduceSource;

  // If there's any sort, create the reduce stage for sorting
  // 1. The function-source is POSTed as JSON, so transform the
  // function-source into a JSON-safe string
  // 2. Insert the actual sort info, replace the dummy __sort__
  if (sort) {
    reduceSource = _reduceFunction.toString() // Get the function source
        // Strip comments
        .replace(/\/\/.*(\n)/g, '')
        // Strip linebreaks
        .replace(/\n/g, ' ')
        // Reduce multiple spaces to single space
        .replace(/ {2,}/g, ' ')
        // Replace placeholder with real sort, e.g., {'foo': 'asc'}
        .replace('\'__sort__\'', sort);
    reduce = ', {"reduce": {"language": "javascript", "source": "' +
        reduceSource + '"}}';
  }

  return '{"inputs": "' + bucket + '", "query": [{"map": {"language": '+
      '"javascript","source": "function (value, keyData, arg) { ' +
      'var data = Riak.mapValuesJson(value)[0]; if ' + conditions +
      ' { return [data]; } else { return []; } }"}}' + reduce + ']}';
};

_serializeForDataType = function (datatype, val) {
  var ret;
  switch (true) {
    case val === null:
      ret = 'null';
      break;
    case val === '':
      ret = '\'\'';
      break;
    case datatype == 'date' || datatype == 'datetime':
      ret = JSON.stringify(val).replace(/"/g, "'");
      break;
    default:
      ret = datatypes[datatype].serialize(val, {
          useQuotes: true
        , escape: true
      });
  }
  return ret;
};

utils.mixin(Adapter.prototype, new (function () {

  var _operationSymbols = {
    'and': '&&'
  , 'or': '||'
  };

  this._serializeSortOrder = function (sort) {
    return sort ? JSON.stringify(sort).replace(/"/g, "'") : '';
  };

  this._serializeConditions = function (conditions) {
    var cond = this._serializeOperation(conditions);
    return cond;
  };

  this._serializeOperation = function (op) {
    var self = this
      , ops = [];
    if (op.isEmpty()) {
      return '(true)';
    }
    else {
      op.forEach(function (o) {
        if (o instanceof operation.OperationBase) {
          ops.push(self._serializeOperation(o));
        }
        else {
          ops.push(self._serializeComparison(o));
        }
      });
      if (op.type == 'not') {
        return '(!(' + self._serializeOperation(op.operand()) + '))';
      }
      else {
        return '(' + ops.join(' ' + _operationSymbols[op.type.toLowerCase()] +
            ' ') + ')';
      }
    }
  };

  this._serializeComparison = function (comp) {
    var ret = ''
      , name = this._serializeComparisonFieldName(comp)
      , arr = [];
    switch (true) {
      case comp instanceof comparison.LikeComparison:
        ret = name + '.indexOf(' +
            this._serializeComparisonValue(comp) + ') === 0';
        break;
      case comp instanceof comparison.InclusionComparison:
        comp.value.forEach(function (item) {
          arr.push(name + ' == ' +
              _serializeForDataType(comp.datatype, item));
        });
        ret = arr.join(' || ');
        break;
      default:
        ret = [name, this._serializeComparisonComparator(comp),
            this._serializeComparisonValue(comp)].join(' ');

    }
    return ret;
  };

  this._serializeComparisonFieldName = function (comp) {
    // Use bracket-notation, in case field-name has special chars
    // or is a reserved word
    var name = 'data[\'' + comp.field + '\']';
    if (comp.opts.nocase) {
      name += '.toLowerCase()';
    }
    return name;
  };

  this._serializeComparisonComparator = function (comp) {
    var comparator = comp.jsComparatorString;
    return comparator;
  };

  this._serializeComparisonValue = function (comp) {
    return _serializeForDataType(comp.datatype, comp.value);
  };

  this.init = function () {};

  this.request = function (options, callback) {
    var opts = options || {}
      , config = this.config
      , method = opts.method || 'GET'
      , url = config.protocol + '://' + config.host + ':' +
            config.port + opts.url;

    //console.log('>>> ', method, ' ', url);

    request({
      method: method
    , url: url
    , data: opts.data || null
    , dataType: 'json'
    , headers: {
        'Content-Type': 'application/json'
      }
    }, callback);
  };

  this.load = function (query, callback) {
    var bucket = _bucketizeModelName(query.model.modelName)
      , id = query.byId
      , requestOpts
      , conditions
      , sort;

    // Single instance-lookup by id
    if (id) {
      requestOpts = {
          url: '/riak/' + bucket + '/' + id
        , method: 'GET'
      };
      this.request(requestOpts, function (err, data) {
        var inst
          , res = [];
        if (err) {
          if (err.statusCode == 404) {
            callback(null, null);
          }
          else {
            callback(err, null);
          }
        }
        else {
          inst = query.model.create(data);
          inst.id = id;
          inst._saved = true;
          res.push(inst);
          // If explicitly limited to one, just return the single instance
          // This is also used by the `first` method
          if (query.opts.limit == 1) {
            res = res[0];
          }
          callback(null, res);
        }
      });
    }
    // Teh mapreducy
    else {
      conditions = this._serializeConditions(query.conditions);
      sort = this._serializeSortOrder(query.opts.sort);
      requestOpts = {
          url: '/mapred'
        , method: 'POST'
        , data: _mapReduceQuery(bucket, conditions, sort)
      };
      this.request(requestOpts, function (err, data) {
        var rows
          , res = [];
        if (err) {
          callback(err, null);
        }
        else {
          rows = data;
          rows.forEach(function (row) {
            var inst = query.model.create(row);
            inst.id = row.id;
            inst._saved = true;
            res.push(inst);
          });
          // If explicitly limited to one, just return the single instance
          // This is also used by the `first` method
          if (query.opts.limit == 1) {
            res = res[0];
          }
          callback(null, res);
        }
      });
    }
  };

  this.update = function (data, query, callback) {
    var bucket = _bucketizeModelName(query.model.modelName)
      , id = query.byId
      , requestOpts
      , item = data;
    // Single instance-lookup by id
    if (id) {
      // Bail out if instance isn't valid
      if (!item.isValid()) {
        return callback(data.errors, null);
      }

      item = item.toData({whitelist: ['id', 'createdAt']});
      item = JSON.stringify(item);

      requestOpts = {
          url: '/riak/' + bucket + '/' + id
        , method: 'PUT'
        , data: item
      };

      this.request(requestOpts, function (err, data) {
        if (err) {
          callback(err, null);
        }
        else {
          // FIXME: What is the right data to return here? Right now this
          // is basically overwriting a doc, but we might be supporting
          // bulk-updates at some point
          callback(null, true);
        }
      });
    }
    // Bulk update?
    else {
      callback(new Error('Bulk update is not supported'), null);
    }
  };

  this.remove = function (query, callback) {
    var self = this
      , bucket = _bucketizeModelName(query.model.modelName)
      , id = query.byId
      , requestOpts
      , remove
      , ids;

    // Single instance-lookup by id
    if (id) {
      requestOpts = {
          url: '/riak/' + bucket + '/' + id
        , method: 'DELETE'
      };
      this.request(requestOpts, function (err, data) {
        var inst
          , res = [];
        if (err) {
          callback(err, null);
        }
        else {
          callback(null, true);
        }
      });
    }
    // Remove via query
    else {
      remove = function () {
        var id
          , url
          , requestOpts;
        if ((id = ids.shift())) {
          url = '/riak/' + bucket + '/' + id;
          requestOpts = {
            url: url
          , method: 'DELETE'
          };
          self.request(requestOpts, function (err, res) {
            if (err) {
              callback(err, null);
            }
            else {
              remove();
            }
          });
        }
        else {
          callback(null, true);
        }
      };
      // We have a list of ids
      if ((ids = query.rawConditions.id)) {
        remove();
      }
      // Do a fetch to get the matching items -- this is like, anti-optimal
      else {
        ids = [];
        this.load(query, function (err, items) {
          if (err) {
            callback(err, null);
          }
          else {
            items.forEach(function (item) {
              id.push(item.id);
            });
            remove();
          }
        });
      }
    }
  };

  this.insert = function (data, opts, callback) {
    var self = this
      , items = Array.isArray(data) ? data.slice() : [data]
      , bucket = _bucketizeModelName(items[0].type)
      , ret = []
      , insert;

    insert = function () {
      var item;
      if ((item = items.shift())) {
        var id = utils.string.uuid()
          , url = '/riak/' + bucket + '/' + id
          , requestOpts;

        item.id = id;
        item = item.toData({whitelist: ['id', 'createdAt']});
        item = JSON.stringify(item);

        requestOpts = {
          url: url
        , method: 'POST'
        , data: item
        };
        self.request(requestOpts, function (err, res) {
          if (err) {
            callback(err, null);
          }
          else {
            item.id = id;
            item._saved = true;
            ret.push(data);
            insert();
          }
        });
      }
      else {
        callback(null, ret);
      }
    };
    insert();
  };

  // May need to set bucket props here?
  this.createTable = function (names, callback) {};

  this.dropTable = function (names, callback) {
    var self = this
      , arr = Array.isArray(names) ? names.slice() : [names]
      , drop;

    drop = function () {
      var name
        , bucket
        , requestOpts;
      if ((name = arr.shift())) {
        bucket = _bucketizeModelName(name);
        requestOpts = {
          url: '/buckets/' + bucket + '/keys?keys=true'
        , method: 'GET'
        };
        self.request(requestOpts, function (err, data) {
          var keys = data.keys;
          if (err) {
            callback(err, null);
          }
          else {
            if (keys.length) {
              model[name].remove({id: keys}, {}, function (err, data) {
                if (err) {
                  callback(err, null);
                }
                else {
                  drop();
                }
              });
            }
            else {
              drop();
            }
          }
        });
      }
      else {
        callback(null, true);
      }
    };
    drop();
  };

})());

module.exports.Adapter = Adapter;
