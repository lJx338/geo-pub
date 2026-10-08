/* JavaScript for Automation, using only macOS system frameworks. No Node/Python installation. */
ObjC.import('Foundation');
// Foundation's URL loading classes are supplied by CFNetwork on current macOS.
ObjC.import('CFNetwork');
ObjC.bindFunction('exit', ['void', ['int']]);
ObjC.bindFunction('isatty', ['int', ['int']]);

function utf8(data) {
  var value = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  if (value.isNil()) throw new Error('Input is not UTF-8');
  return ObjC.unwrap(value);
}
function bytes(text) { return $(text).dataUsingEncoding($.NSUTF8StringEncoding); }
function readData(path) {
  var data = $.NSData.dataWithContentsOfFile(path);
  if (data.isNil()) throw new Error('Cannot read input file: ' + path);
  return data;
}
function readJSON(path) { return JSON.parse(utf8(readData(path))); }
function write(handle, text) { if (text) handle.writeData(bytes(text)); }
function absolute(path) {
  return ObjC.unwrap($(path[0] === '/' ? path : ObjC.unwrap($.NSFileManager.defaultManager.currentDirectoryPath) + '/' + path).stringByStandardizingPath);
}
function run(argv) {
  var args = argv.slice(1);
  try {
    var directory = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('GEO_PUBLISHER_USER_DATA_DIR'));
    if (!directory) throw new Error('Please copy the current connection instructions from GEO Publisher > 连接 WorkBuddy.');
    var files = [], seen = {}, total = 0;
    function addFile(path, json) {
      if (Object.prototype.hasOwnProperty.call(seen, path)) return;
      seen[path] = true;
      var data = readData(absolute(path));
      total += Number(data.length);
      if (total > 64 * 1024 * 1024 || files.length >= 64) throw new Error('Import files separately: maximum 64 MB / 64 files per command.');
      if (json) scan(JSON.parse(utf8(data)));
      files.push({ path: path, base64: ObjC.unwrap(data.base64EncodedStringWithOptions(0)), json: json });
    }
    function scan(value) {
      if (!value || typeof value !== 'object') return;
      Object.keys(value).forEach(function (key) {
        var item = value[key];
        if ((key === 'coverPath' || key === 'sourcePath' || key === 'localPath') && typeof item === 'string' && item && !/^https?:\/\//.test(item)) addFile(item, false);
        else if (item && typeof item === 'object') scan(item);
      });
    }
    for (var i = 0; i < args.length; i++) {
      if (args[i] === '--input' || args[i] === '--path') {
        if (i + 1 < args.length) { addFile(args[i + 1], args[i] === '--input'); i++; }
      }
    }
    var stdin = '';
    if (['validate', 'fill', 'publish'].indexOf(args[0]) >= 0 && args.indexOf('--input') < 0 && $.isatty(0) === 0) {
      var input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
      if (Number(input.length) > 5 * 1024 * 1024) throw new Error('JSON input exceeds 5 MB');
      stdin = utf8(input);
      if (stdin.trim()) scan(JSON.parse(stdin));
    }
    function connection() {
      var url = readJSON(directory + '/mas-cli-bridge.json').url;
      var match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(url);
      if (!match || Number(match[1]) > 65535) throw new Error('Invalid local bridge address');
      var token = readJSON(directory + '/control-token.json').token;
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local control token');
      return { url: url, token: token };
    }
    function request(target, route, body, timeout) {
      var req = $.NSMutableURLRequest.requestWithURL($.NSURL.URLWithString(target.url + route));
      req.setTimeoutInterval(timeout);
      req.setValueForHTTPHeaderField('Bearer ' + target.token, 'Authorization');
      if (body !== undefined) {
        req.setHTTPMethod('POST');
        req.setValueForHTTPHeaderField('application/json', 'Content-Type');
        req.setHTTPBody(bytes(JSON.stringify(body)));
      }
      var response = Ref(), error = Ref();
      var data = $.NSURLConnection.sendSynchronousRequestReturningResponseError(req, response, error);
      if (data.isNil()) throw new Error('Cannot connect to GEO Publisher. Open the app and retry.');
      var result = JSON.parse(utf8(data));
      if (Number(response[0].statusCode) !== 200) throw new Error(result.error || 'Local bridge request failed');
      return result;
    }
    var target;
    try { target = connection(); request(target, '/health', undefined, 2); } catch (initialError) {
      var appPath = argv[0].split('/Contents/')[0];
      if (!/\.app$/.test(appPath)) throw initialError;
      var task = $.NSTask.alloc.init;
      task.setLaunchPath('/usr/bin/open');
      task.setArguments(['-a', appPath]);
      task.launch;
      task.waitUntilExit;
      var ready = false;
      for (var attempt = 0; attempt < 30; attempt++) {
        try { target = connection(); request(target, '/health', undefined, 1); ready = true; break; } catch (_) { $.NSThread.sleepForTimeInterval(1); }
      }
      if (!ready) throw new Error('GEO Publisher did not become ready. Open the app and copy 连接 WorkBuddy again.');
    }
    // Never retry the command automatically: a publish might already have reached the platform.
    var result = request(target, '/v1/cli', { args: args, stdin: stdin, files: files }, 300);
    write($.NSFileHandle.fileHandleWithStandardOutput, result.stdout);
    write($.NSFileHandle.fileHandleWithStandardError, result.stderr);
    $.exit(result.exitCode);
  } catch (error) {
    write($.NSFileHandle.fileHandleWithStandardError, JSON.stringify({ ok: false, command: args[0] || 'status', error: { code: 'MAS_CLI_CONNECTION_ERROR', message: String(error) } }) + '\n');
    $.exit(1);
  }
}
