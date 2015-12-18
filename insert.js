'use strict';

var Writable = require('readable-stream/writable');
var path = require('path');
var url = require('url');
var util = require('util');
var async = require('async');
var spawn = require('child_process').spawn;
var once = require('one-time');
var fs = require('fs');
var os = require('os');
var uuid = require('uuid');
var nerfGun = require('nerf-gun')
var semver = require('semver');
var bl = require('bl');
var debug = require('diagnostics')('registry-migrate:insert');

// prevent fallthrough to the global registry
var npmrc_global_file = path.join(__dirname, 'npmrc-global');

module.exports = Insert;

util.inherits(Insert, Writable);

function Insert(opts) {
  Writable.call(this, { objectMode: true });

  this.destination = opts.destination || opts;
  if (typeof this.destination !== 'string')
    throw new Error('destination must be a string');

  this.parsed =  url.parse(this.destination);
  if (opts.auth || this.parsed.auth)
    this.auth = new Buffer(opts.auth || this.parsed.auth, 'utf8').toString('base64');
  this.parsed.auth = undefined;
  this.destination = this.parsed.format().replace(/\/+$/, '');

}

/**
 * Implement a writable stream that publishes packages in version order
 */
Insert.prototype._write = function (data, enc, callback) {
  var name = data.name;
  var versions = data.versions;
  var keys = Object.keys(versions).sort(compare);

  debug('publishing %d versions of %s', keys.length, name);

  async.eachSeries(keys, (version, next) => {
    this.publish(versions[version], next);
  }, callback);
};


Insert.prototype.publish = function (dir, callback) {
  var fn = once(callback);
  // create a temporary .npmrc file so we can auth safely against a registry
  var user = '';
  var pass = '';
  if (this.auth) {
    var parsed_auth = new Buffer(this.auth, 'base64').toString('utf8');
    var parts = /^([^:]*)(?:[:]([\s\S]*))?$/.exec(parsed_auth);
    user = parts[1];
    pass = parts[2] ? new Buffer(parts[2]).toString('base64') : '';
  }
  
  var nerfdart = nerfGun(this.destination);
  
  var npmrc = `# generated by github.com/jcrugzz/registry-migrate
    _auth=${this.auth||''}
    registry=${this.destination}
    loglevel=info
    always-auth=false
    ${nerfdart}:_auth=${this.auth||''}
    ${nerfdart}:username=${user}
    ${nerfdart}:_password=${pass}
    ${nerfdart}:always-auth=false
    # email is required by npm, .invalid is a banned TLD, info purposes only
    ${nerfdart}:email=jcrugzz+registry-migrate@github.com.invalid
    `;
  
  var npmrc_file = path.join(os.tmpdir(),uuid());
  fs.writeFile(npmrc_file, npmrc, {mode:0o400}, function (write_npmrc_err) {
    if (write_npmrc_err) { return fn(write_npmrc_err); }
    // best effort delete of tmp .npmrc file, don't care if it fails really
    var oldfn = fn;
    fn = function () {
      fs.unlink(npmrc_file, err => {});
      return oldfn.apply(this, arguments);
    };
  
    //
    // Publish a package. This should hit destination without issue
    // since we remove any possible `.npmrc` we may want to use a path to an
    // `.npmrc` if this is not sufficient
    //
    var args = [
      'publish',
      '--ignore-scripts',
      `--userconfig=${npmrc_file}`,
      `--globalconfig=${npmrc_global_file}`
    ];

    var env = {
      PATH:process.env.PATH,
      HOME:process.env.HOME
    };
  
    var child = spawn('npm', args, {
      env: env,
      stdio: ['ignore', 'ignore', 'pipe'],
      cwd: dir
    });
  
    child.on('error', fn);
    
    child.stderr.pipe(bl(function (err, data) {
      if (err) { return fn(err); }
      if (data && data.length) {
        debug('Stderr output %s', data.toString());
      }
    }));
  
    child.on('exit', function (code, signal) {
      if (code !== 0) {
        return fn(new Error(`Child exited with code ${code} and Signal ${signal || 'none'}`));
      }
      fn();
    });
  
  });

};

function compare(a, b) {
  return semver.lt(a, b) ? -1 : 1;
}
