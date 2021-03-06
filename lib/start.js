var path = require('path');
var fs = require('fs');
var os = require('os');
var http = require('http');
var url = require('url');
var cp = require('child_process');
var inquirer = require('inquirer');
var JWebDriver = require('jwebdriver');
var async = require('async');
var co = require('co');
var expect  = require('expect.js');

var faker = require('faker');
var WebSocketServer = require('websocket').server;
var i18n = require('./i18n');
var colors = require('colors');

var symbols = {
  ok: '✓',
  err: '✖'
};
if (process.platform === 'win32') {
  symbols.ok = '\u221A';
  symbols.err = '\u00D7';
}

var wsConnection;

function startRecorder(locale){
    if(locale){
        i18n.setLocale(locale);
    }
    var configFile = path.resolve('config.json');
    var configJson = {};
    if(fs.existsSync(configFile)){
        var content = fs.readFileSync(configFile).toString();
        try{
            configJson = JSON.parse(content);
        }
        catch(e){
            console.log('config.json '.bold + __('json_parse_failed').red);
            process.exit(1);
        }
    }
    else{
        console.log('config.json '.bold+__('file_missed').red);
        process.exit(1);
    }
    var testVars = configJson.vars;
    var hostsFile = path.resolve('hosts');
    var hosts = '';
    if(fs.existsSync(hostsFile)){
        hosts = fs.readFileSync(hostsFile).toString();
    }
    // read spec list
    var dirList = fs.readdirSync(process.cwd());
    var specLists = [];
    dirList.forEach(function(item){
        if(/.*\.js$/.test(item)){
            specLists.push(item);
        }
    });

    var questions = [
        {
            'type': 'input',
            'name': 'fileName',
            'message': __('input_spec_name'),
            'default': 'test.spec.js',
            'validate': function(input){
                return input !== '';
            }
        },
        {
            'type': 'confirm',
            'name': 'checker',
            'message': __('open_checker_browser'),
            'default': true
        },
        {
            'type': 'input',
            'name': 'pathAttrs',
            'message': __('dom_path_config'),
            'default': 'data-id,data-name,type,data-type,data-role,data-value'
        }
    ];
    inquirer.prompt(questions).then(function(anwsers){
        var fileName = anwsers.fileName;
        var openChecker = anwsers.checker;
        var pathAttrs = anwsers.pathAttrs;

        var arrTestCodes = [];
        var recorderBrowser, checkerBrowser;
        var lastWindowId = 0;
        var lastFrameId = null;
        var lastTestTitle = '';
        var arrLastTestCodes = [];
        var allCaseCount = 0;
        var failedCaseCount = 0;
        function pushTestCode(cmd, text, ext, codes){
            var title = cmd +': ';
            title += text ? text + ' ( '+ext+' )' : ext;
            lastTestTitle = title;
            arrLastTestCodes = [];
            if(Array.isArray(codes)){
                codes.forEach(function(line){
                    arrLastTestCodes.push('    '+line);
                });
            }
            else{
                arrLastTestCodes.push('    '+codes);
            }
            title = title.replace(/^\w+:/, function(all){
                return all.cyan;
            });
            console.log('  '+title);
        }
        function saveTestCode(success, error){
            if(checkerBrowser){
                if(success){
                    console.log('   '+symbols.ok.green+__('check_succeed').green);
                }
                else{
                    console.log('   '+symbols.err.red+__('check_failed').red, error);
                }
            }
            allCaseCount ++;
            if(!success){
                failedCaseCount ++;
            }
            if(arrLastTestCodes.length > 0){
                checkerBrowser && sendWsMessage('checkResult', {
                    title: lastTestTitle,
                    success: success
                });
                if(!success){
                    lastTestTitle = '\u00D7 ' + lastTestTitle;
                }
                arrTestCodes.push('it(\''+lastTestTitle.replace(/'/g, '\\\'').replace(/\n/g, '\\n')+'\', function*(){');
                arrTestCodes = arrTestCodes.concat(arrLastTestCodes);
                arrTestCodes.push("});");
                arrTestCodes.push("");
                lastTestTitle = '';
                arrLastTestCodes = [];
            }
        }
        var cmdQueue = async.queue(function(cmdInfo, next) {
            var window = cmdInfo.window;
            var frame = cmdInfo.frame;
            var cmd = cmdInfo.cmd;
            var data = cmdInfo.data;
            var arrTasks = [];
            arrTasks.push(function(callback){
                function doNext(){
                    saveTestCode(true);
                    callback();
                }
                function catchError(error){
                    saveTestCode(false, error);
                    callback();
                }
                if(window !== lastWindowId){
                    lastWindowId = window;
                    lastFrameId = null;
                    pushTestCode('switchWindow', '', window, 'yield browser.sleep(500).switchWindow('+window+');')
                    checkerBrowser && checkerBrowser.switchWindow(window).then(doNext).catch(catchError) || callback();
                }
                else{
                    callback();
                }
            });
            arrTasks.push(function(callback){
                function doNext(){
                    saveTestCode(true);
                    callback();
                }
                function catchError(error){
                    saveTestCode(false, error);
                    callback();
                }
                if(frame !== lastFrameId){
                    lastFrameId = frame;
                    var arrCodes = [];
                    arrCodes.push('yield browser.switchFrame(null);');
                    if(frame !== null){
                        arrCodes.push('var element = yield browser.wait(\''+frame+'\', 30000);');
                        arrCodes.push('yield browser.switchFrame(element).wait(\'body\');');
                    }
                    pushTestCode('switchFrame', '', frame, arrCodes);
                    checkerBrowser && checkerBrowser.switchFrame(null, function*(error){
                        if(frame !== null){
                            var element = yield checkerBrowser.wait(frame, 10000);
                            yield checkerBrowser.switchFrame(element).wait('body');
                        }
                    }).then(doNext).catch(catchError) || doNext();
                }
                else{
                    callback();
                }

            });
            arrTasks.push(function(callback){
                function doNext(){
                    saveTestCode(true);
                    callback();
                }
                function catchError(error){
                    saveTestCode(false, error);
                    callback();
                }
                var arrCodes = [];
                function eacapeStr(str){
                    return str.replace(/\'/g, "\\'");
                }
                switch(cmd){
                    case 'url':
                        pushTestCode('url', '', data.url, 'yield browser.url(\''+eacapeStr(data.url)+'\');');
                        checkerBrowser && checkerBrowser.url(data.url).then(doNext).catch(catchError) || doNext();
                        break;
                    case 'closeWindow':
                        pushTestCode('closeWindow', '', '', 'yield browser.closeWindow();');
                        checkerBrowser && checkerBrowser.closeWindow().then(doNext).catch(catchError) || doNext();
                        break;
                    case 'sleep':
                        pushTestCode('sleep', '', data.time, 'yield browser.sleep('+data.time+');');
                        checkerBrowser && checkerBrowser.sleep(data.time).then(doNext).catch(catchError) || doNext();
                        break;
                    case 'waitBody':
                        pushTestCode('waitBody', '', '', 'yield browser.sleep(500).wait(\'body\', 30000);');
                        checkerBrowser && checkerBrowser.sleep(500).wait('body', 10000).then(doNext).catch(catchError) || doNext();
                        break;
                    case 'mouseMove':
                        arrCodes = [];
                        arrCodes.push('var element = yield browser.sleep(300).wait(\''+eacapeStr(data.path)+'\', 30000);');
                        if(data.x !== undefined){
                            arrCodes.push('yield browser.sleep(300).mouseMove(element, '+data.x+', '+data.y+');');
                        }
                        else{
                            arrCodes.push('yield browser.sleep(300).mouseMove(element);');
                        }
                        pushTestCode('mouseMove', data.text, data.path+(data.x !== undefined?', '+data.x+', '+data.y:''), arrCodes);
                        checkerBrowser && checkerBrowser.sleep(300).wait(data.path, 10000).then(function*(element){
                            yield checkerBrowser.sleep(300).mouseMove(element, data.x, data.y);
                        }).then(doNext).catch(catchError) || doNext();
                        break;
                    case 'mouseDown':
                        arrCodes = [];
                        arrCodes.push('var element = yield browser.sleep(300).wait(\''+eacapeStr(data.path)+'\', 30000);');
                        arrCodes.push('yield browser.sleep(300).mouseMove(element, '+data.x+', '+data.y+').mouseDown('+data.button+');');
                        pushTestCode('mouseDown', data.text, data.path + ', ' + data.x + ', ' + data.y + ', ' + data.button, arrCodes);
                        checkerBrowser && checkerBrowser.sleep(300).wait(data.path, 10000).then(function*(element){
                            yield checkerBrowser.sleep(300).mouseMove(element, data.x, data.y).mouseDown(data.button);
                        }).then(doNext).catch(catchError) || doNext();
                        break;
                    case 'mouseUp':
                        arrCodes = [];
                        arrCodes.push('var element = yield browser.sleep(300).wait(\''+eacapeStr(data.path)+'\', 30000);');
                        arrCodes.push('yield browser.sleep(300).mouseMove(element, '+data.x+', '+data.y+').mouseUp('+data.button+');');
                        pushTestCode('mouseUp', data.text, data.path + ', ' + data.x + ', ' + data.y + ', ' + data.button, arrCodes);
                        checkerBrowser && checkerBrowser.sleep(300).wait(data.path, 10000).then(function*(element){
                            yield checkerBrowser.sleep(300).mouseMove(element, data.x, data.y).mouseUp(data.button);
                        }).then(doNext).catch(catchError) || doNext();
                        break;
                    case 'click':
                        arrCodes = [];
                        arrCodes.push('var element = yield browser.sleep(300).wait(\''+eacapeStr(data.path)+'\', 30000);');
                        arrCodes.push('yield browser.sleep(300).mouseMove(element, '+data.x+', '+data.y+').click('+data.button+');');
                        pushTestCode('click', data.text, data.path + ', ' + data.x + ', ' + data.y + ', ' + data.button, arrCodes);
                        checkerBrowser && checkerBrowser.sleep(300).wait(data.path, 10000).then(function*(element){
                            yield checkerBrowser.sleep(300).mouseMove(element, data.x, data.y).click(data.button);
                        }).then(doNext).catch(catchError) || doNext();
                        break;
                    case 'touchClick':
                        arrCodes = [];
                        arrCodes.push('var element = yield browser.sleep(300).wait(\''+eacapeStr(data.path)+'\', 30000);');
                        arrCodes.push('yield element.sleep(300).touchClick();');
                        pushTestCode('touchClick', data.text, data.path, arrCodes);
                        checkerBrowser && checkerBrowser.sleep(300).wait(data.path, 10000).then(function*(element){
                            yield element.sleep(300).touchClick();
                        }).then(doNext).catch(catchError) || doNext();
                        break;
                    case 'dblClick':
                        arrCodes = [];
                        arrCodes.push('var element = yield browser.sleep(300).wait(\''+eacapeStr(data.path)+'\', 30000);');
                        arrCodes.push('yield browser.sleep(300).mouseMove(element, '+data.x+', '+data.y+').click().click();');
                        pushTestCode('dblClick', data.text, data.path + ', ' + data.x + ', ' + data.y + ', ' + data.button, arrCodes);
                        checkerBrowser && checkerBrowser.sleep(300).wait(data.path, 10000).then(function*(element){
                            yield checkerBrowser.sleep(300).mouseMove(element, data.x, data.y).click().click();
                        }).then(doNext).catch(catchError) || doNext();
                        break;
                    case 'sendKeys':
                        pushTestCode('sendKeys', '', data.keys, 'yield browser.sendKeys(\''+eacapeStr(data.keys)+'\');');
                        checkerBrowser && checkerBrowser.sendKeys(data.keys).then(doNext).catch(catchError) || doNext();
                        break;
                    case 'keyDown':
                        pushTestCode('keyDown', '', data.character, 'yield browser.keyDown(\''+eacapeStr(data.character)+'\');');
                        checkerBrowser && checkerBrowser.keyDown(data.character).then(doNext).catch(catchError) || doNext();
                        break;
                    case 'keyUp':
                        pushTestCode('keyUp', '', data.character, 'yield browser.keyUp(\''+eacapeStr(data.character)+'\');');
                        checkerBrowser && checkerBrowser.keyUp(data.character).then(doNext).catch(catchError) || doNext();
                        break;
                    case 'scrollTo':
                        pushTestCode('scrollTo', '', data.x + ', ' + data.y, 'yield browser.scrollTo('+data.x+', '+data.y+');');
                        checkerBrowser && checkerBrowser.scrollTo(data.x, data.y).then(doNext).catch(catchError) || doNext();
                        break;
                    case 'select':
                        arrCodes = [];
                        arrCodes.push('var element = yield browser.sleep(300).wait(\''+eacapeStr(data.path)+'\', 30000);');
                        arrCodes.push('yield element.sleep(300).select({');
                        arrCodes.push('    type: \''+data.type+'\',');
                        arrCodes.push('    value: \''+data.value+'\'');
                        arrCodes.push('});');
                        pushTestCode('select', data.text, data.path + ', ' + data.type + ', ' + data.value, arrCodes);
                        checkerBrowser && checkerBrowser.sleep(300).wait(data.path, 10000).then(function*(element){
                            yield element.sleep(300).select({
                                type: data.type,
                                value: data.value
                            });
                        }).then(doNext).catch(catchError) || doNext();
                        break;
                    case 'acceptAlert':
                        pushTestCode('acceptAlert', '', '', 'yield browser.acceptAlert();');
                        checkerBrowser && checkerBrowser.acceptAlert().then(doNext).catch(catchError) || doNext();
                        break;
                    case 'dismissAlert':
                        pushTestCode('dismissAlert', '', '', 'yield browser.dismissAlert();');
                        checkerBrowser && checkerBrowser.dismissAlert().then(doNext).catch(catchError) || doNext();
                        break;
                    case 'setAlert':
                        pushTestCode('setAlert', '', data.text, 'yield browser.setAlert("'+data.text+'");');
                        checkerBrowser && checkerBrowser.setAlert(data.text).then(doNext).catch(catchError) || doNext();
                        break;
                    case 'uploadFile':
                        arrCodes = [];
                        arrCodes.push('var element = yield browser.sleep(300).wait(\''+eacapeStr(data.path)+'\', {timeout: 30000, displayed: false});');
                        arrCodes.push('yield element.sleep(300).sendKeys(\'c:\\\\uploadFiles\\\\'+data.filename+'\');');
                        pushTestCode('uploadFile', data.text, data.path + ', ' + data.filename, arrCodes);
                        checkerBrowser && checkerBrowser.sleep(300).wait(data.path, {
                            timeout: 10000,
                            displayed: false
                        }).then(function*(element){
                            yield element.sleep(300).sendKeys('c:\\uploadFiles\\'+data.filename);
                        }).then(doNext).catch(catchError) || doNext();
                        break;
                    // 添加断言
                    case 'expect':
                        co(function*(){
                            var expectType = data.type;
                            var expectParams = data.params;
                            var expectCompare = data.compare;
                            var expectTo = data.to;
                            arrCodes = [];
                            var reDomRequire = /^(val|text|displayed|enabled|selected|attr|css)$/;
                            var reParamRequire = /^(attr|css|cookie|localStorage|sessionStorage)$/;
                            if(reDomRequire.test(expectType)){
                                arrCodes.push('var element = yield browser.sleep(300).wait(\''+eacapeStr(expectParams[0])+'\', 30000);');
                            }
                            switch(expectType){
                                case 'val':
                                    arrCodes.push('var value = yield element.val();');
                                    break;
                                case 'text':
                                    arrCodes.push('var value = yield element.text();');
                                    break;
                                case 'displayed':
                                    arrCodes.push('var value = yield element.displayed();');
                                    break;
                                case 'enabled':
                                    arrCodes.push('var value = yield element.enabled();');
                                    break;
                                case 'selected':
                                    arrCodes.push('var value = yield element.selected();');
                                    break;
                                case 'attr':
                                    arrCodes.push('var value = yield element.attr(\''+eacapeStr(expectParams[1])+'\');');
                                    break;
                                case 'css':
                                    arrCodes.push('var value = yield element.css(\''+eacapeStr(expectParams[1])+'\');');
                                    break;
                                case 'url':
                                    arrCodes.push('var value = yield browser.url();');
                                    break;
                                case 'title':
                                    arrCodes.push('var value = yield browser.title();');
                                    break;
                                case 'cookie':
                                    arrCodes.push('var value = yield browser.cookie(\''+eacapeStr(expectParams[0])+'\');');
                                    break;
                                case 'localStorage':
                                    arrCodes.push('var value = yield browser.localStorage(\''+eacapeStr(expectParams[0])+'\');');
                                    break;
                                case 'sessionStorage':
                                    arrCodes.push('var value = yield browser.sessionStorage(\''+eacapeStr(expectParams[0])+'\');');
                                    break;
                            }
                            var codeExpectTo = expectTo.replace(/"/g, '\\"').replace(/\n/g, '\\n');
                            switch(expectCompare){
                                case 'equal':
                                    arrCodes.push('expect(value).to.equal('+(/^(true|false)$/.test(codeExpectTo)?codeExpectTo:'\''+eacapeStr(codeExpectTo)+'\'')+');');
                                    break;
                                case 'contain':
                                    arrCodes.push('expect(value).to.contain(\''+eacapeStr(codeExpectTo)+'\');');
                                    break;
                                case 'regexp':
                                    arrCodes.push('expect(value).to.match('+eacapeStr(codeExpectTo)+');');
                                    break;
                            }
                            pushTestCode('expect', '', expectType + ', ' + JSON.stringify(expectParams) + ', ' + expectCompare + ', ' + expectTo, arrCodes);
                            if(checkerBrowser){
                                var element, value;
                                if(reDomRequire.test(expectType)){
                                    element = yield checkerBrowser.sleep(300).wait(expectParams[0], 10000);
                                }
                                switch(expectType){
                                    case 'val':
                                        value = yield element.val();
                                        break;
                                    case 'text':
                                        value = yield element.text();
                                        break;
                                    case 'displayed':
                                        value = yield element.displayed();
                                        break;
                                    case 'enabled':
                                        value = yield element.enabled();
                                        break;
                                    case 'selected':
                                        value = yield element.selected();
                                        break;
                                    case 'attr':
                                        value = yield element.attr(expectParams[1]);
                                        break;
                                    case 'css':
                                        value = yield element.css(expectParams[1]);
                                        break;
                                    case 'url':
                                        value = yield checkerBrowser.url();
                                        break;
                                    case 'title':
                                        value = yield checkerBrowser.title();
                                        break;
                                    case 'cookie':
                                        value = yield checkerBrowser.cookie(expectParams[0]);
                                        break;
                                    case 'localStorage':
                                        value = yield checkerBrowser.localStorage(expectParams[0]);
                                        break;
                                    case 'sessionStorage':
                                        value = yield checkerBrowser.sessionStorage(expectParams[0]);
                                        break;
                                }
                                switch(expectCompare){
                                    case 'equal':
                                        expectTo = /^(true|false)$/.test(expectTo)?eval(expectTo):expectTo;
                                        expect(value).to.equal(expectTo);
                                        break;
                                    case 'contain':
                                        expect(value).to.contain(expectTo);
                                        break;
                                    case 'regexp':
                                        expect(value).to.match(eval(expectTo));
                                        break;
                                }
                            }
                        }).then(doNext).catch(catchError);
                        break;
                    // 设置变量
                    case 'setVar':
                        var varinfo = data.varinfo;
                        var varType = varinfo.type;
                        arrCodes = [];
                        arrCodes.push('var element = yield browser.sleep(300).wait(\''+eacapeStr(data.path)+'\', 30000);');
                        if(varType ==='faker'){
                            arrCodes.push('faker.locale = \'' + varinfo.lang + '\';');
                            arrCodes.push('yield element.val(faker.fake(\''+eacapeStr(varinfo.str)+'\'));');
                            pushTestCode('setFaker', data.text, data.path + ', ' + varinfo.lang + ', ' + varinfo.str, arrCodes);
                        }
                        else{
                            arrCodes.push('yield element.val(testVars[\''+eacapeStr(varinfo.name)+'\']);');
                            pushTestCode('setVar', data.text, data.path + ', ' + varinfo.name, arrCodes);
                        }
                        checkerBrowser && checkerBrowser.sleep(300).wait(data.path, 10000).then(function*(element){
                            if(varType === 'faker'){
                                faker.locale = varinfo.lang;
                                yield element.val(faker.fake(varinfo.str));
                            }
                            else{
                                yield element.val(testVars[varinfo.name]);
                            }
                        }).then(doNext).catch(catchError) || doNext();
                        break;
                    // 插入用例
                    case 'module':
                        co(function*(){
                            console.log(('  -------------- start load '+data+' --------------').gray);
                            sendWsMessage('moduleStart', {
                                file: data
                            });
                            var arrTasks = [runSpec(data, recorderBrowser, testVars, function(title, errorMsg){
                                title = title.replace(/^\w+:/, function(all){
                                    return all.cyan;
                                });
                                console.log('  '+title);
                                console.log('   '+(errorMsg?symbols.err.red+__('exec_failed').red + '\t' + errorMsg:symbols.ok.green+__('exec_succeed').green));
                            })];
                            if(checkerBrowser){
                                arrTasks.push(runSpec(data, checkerBrowser, testVars))
                            }
                            yield arrTasks;
                            yield recorderBrowser.sleep(1000);
                            yield recorderBrowser.eval(function(done){
                                setInterval(function(){
                                    if(document.readyState==='complete')done()
                                }, 10);
                            });
                            sendWsMessage('moduleEnd', {
                                file: data,
                                success: true
                            });
                            arrTestCodes.push('callSpec(\''+data+'\');\r\n');
                            console.log(('  -------------- end load '+data+' --------------').gray);
                            console.log('  module'.cyan+': ', data);
                        }).then(doNext).catch(function(err){
                            console.log(('  -------------- load '+data+' failed --------------').gray);
                            sendWsMessage('moduleEnd', {
                                file: data,
                                success: false
                            });
                            catchError(err);
                        });
                        break;
                }
            });
            function* runSpec(name, browser, testVars, callback){
                global.before = function(){}
                global.describe = function(){}
                var arrSpecs = [];
                global.it = function(title, func){
                    arrSpecs.push({
                        title: title,
                        func: func
                    });
                }
                require(path.resolve(process.cwd(), name))(browser, testVars);
                var spec;
                for(var i in arrSpecs){
                    spec = arrSpecs[i];
                    var errorMsg = null;
                    try{
                        yield spec.func();
                    }
                    catch(e){
                        errorMsg = e;
                    }
                    callback && callback(spec.title, errorMsg);
                }
            }
            async.series(arrTasks, function(){
                next();
            });
        }, 1);
        function onReady(){
            var localIp = getLocalIP();
            hosts += '\r\n'+localIp +' ui-recorder-server';
            // checker browser
            if(openChecker){
                newChromeBrowser(hosts, false, function*(browser){
                    checkerBrowser = browser;
                    console.log(__('checker_browser_opened').green);
                    for(var i=0;i<900;i++){
                        if(checkerBrowser){
                            yield checkerBrowser.size();
                            yield checkerBrowser.sleep(2000);
                        }
                        else{
                            break;
                        }
                    }
                });
            }
            setTimeout(function(){
                // recorder browser
                newChromeBrowser(hosts, true, function*(browser){
                    recorderBrowser = browser;
                    yield browser.url('chrome-extension://njkfhfdkecbpjlnfmminhmdcakopmcnc/start.html');// dogndkcimpklgbloegagahcgpcbdepfp
                    console.log(__('recorder_browser_opened').green);
                    console.log('');
                    console.log('------------------------------------------------------------------'.green);
                    console.log('');
                    for(var i=0;i<900;i++){
                        if(recorderBrowser){
                            yield recorderBrowser.size();
                            yield recorderBrowser.sleep(2000);
                        }
                        else{
                            break;
                        }
                    }
                });
            }, 500);
        }
        var arrSendKeys = [];
        var lastCmdInfo0 = null;
        var lastCmdInfo1 = null;
        var lastCmdInfo2 = null;
        var dblClickFilterTimer = null;
        function onCommand(cmdInfo){
            // 合并命令流
            function sendKeysFilter(cmdInfo){
                // 合并连续的sendKeys
                var cmd = cmdInfo.cmd;
                var data = cmdInfo.data;
                if(cmd === 'sendKeys'){
                    arrSendKeys.push(data.keys);
                }
                else{
                    if(arrSendKeys.length > 0){
                        // 满足条件，进行合并
                        clickFilter({
                            window: lastCmdInfo0.window,
                            frame: lastCmdInfo0.frame,
                            cmd: 'sendKeys',
                            data: {
                                keys: arrSendKeys.join('')
                            }
                        });
                        arrSendKeys = [];
                    }
                    clickFilter(cmdInfo);
                }
                lastCmdInfo0 = cmdInfo;
            }
            function clickFilter(cmdInfo){
                // 合并为click，增加兼容性 (mouseDown不支持button参数)
                var cmd = cmdInfo.cmd;
                var data = cmdInfo.data;
                if(lastCmdInfo1 && lastCmdInfo1.cmd === 'mouseDown'){
                    var lastCmdData = lastCmdInfo1.data;
                    if(cmd === 'mouseUp' &&
                        cmdInfo.window === lastCmdInfo1.window &&
                        cmdInfo.frame === lastCmdInfo1.frame &&
                        lastCmdData.path === data.path &&
                        Math.abs(lastCmdData.x - data.x) < 20 &&
                        Math.abs(lastCmdData.y - data.y) < 20
                    ){
                        // 条件满足，合并为click
                        cmdInfo = {
                            window: cmdInfo.window,
                            frame: cmdInfo.frame,
                            cmd: 'click',
                            data: data,
                            text: cmdInfo.text
                        };
                    }
                    else{
                        // 不需要合并，恢复之前旧的mouseDown
                        dblClickFilter(lastCmdInfo1);
                    }
                }
                if(cmdInfo.cmd !== 'mouseDown'){
                    // mouseDown 缓存到下一次，确认是否需要合并click，非mouseDown立即执行
                    dblClickFilter(cmdInfo);
                }
                lastCmdInfo1 = cmdInfo;
            }
            function dblClickFilter(cmdInfo){
                // 合并为dblClick，增加兼容性, 某些浏览器不支持连续的两次click
                var cmd = cmdInfo.cmd;
                var data = cmdInfo.data;
                if(lastCmdInfo2 && lastCmdInfo2.cmd === 'click'){
                    var lastCmdData = lastCmdInfo2.data;
                    clearTimeout(dblClickFilterTimer);
                    if(cmd === 'click' &&
                        cmdInfo.window === lastCmdInfo2.window &&
                        cmdInfo.frame === lastCmdInfo2.frame &&
                        lastCmdData.path === data.path &&
                        Math.abs(lastCmdData.x - data.x) < 20 &&
                        Math.abs(lastCmdData.y - data.y) < 20
                    ){
                        // 条件满足，合并为click
                        cmdInfo = {
                            window: cmdInfo.window,
                            frame: cmdInfo.frame,
                            cmd: 'dblClick',
                            data: data,
                            text: cmdInfo.text
                        };
                    }
                    else{
                        // 不需要合并，恢复之前旧的click
                        cmdQueue.push(lastCmdInfo2);
                    }
                }
                if(cmdInfo.cmd !== 'click'){
                    // click 缓存到下一次，确认是否需要合并dblClick，非click立即执行
                    cmdQueue.push(cmdInfo);
                }
                else{
                    // 400毫秒以内才进行dblClick合并
                    dblClickFilterTimer = setTimeout(function(){
                        cmdQueue.push(lastCmdInfo2);
                        lastCmdInfo2 = null;
                    }, 400);
                }
                lastCmdInfo2 = cmdInfo;
            }
            sendKeysFilter(cmdInfo);
        }
        function onEnd(){
            recorderBrowser.close(function(){
                recorderBrowser = null;
                console.log('');
                console.log('------------------------------------------------------------------'.green);
                console.log('');
                saveTestFile();
                console.log(__('recorder_server_closed').green);
                console.log(__('recorder_browser_closed').green);
                checkerBrowser && checkerBrowser.close(function(){
                    checkerBrowser = null;
                    console.log(__('checker_browser_closed').green);
                    process.exit();
                }) || process.exit();
            });
        }
        var recorderConfig = {
            pathAttrs : pathAttrs,
            testVars: testVars,
            specLists: specLists,
            i18n: __('chrome')
        };
        startChromeDriver();
        startRecorderServer(recorderConfig, onReady, onCommand, onEnd);
        function saveTestFile(){
            var tempalteFile = path.resolve(__dirname, '../template/jwebdriver.js');
            var templateContent = fs.readFileSync(tempalteFile).toString();
            var testFile = path.resolve(fileName);
            arrTestCodes = arrTestCodes.map(function(line){
                return '    '+ line;
            });
            templateContent = templateContent.replace(/\{\$(\w+)\}/g, function(all, name){
                switch(name){
                    case 'testCodes':
                        return arrTestCodes.join('\r\n');
                }
                return all;
            });
            fs.writeFileSync(testFile, templateContent);
            if(checkerBrowser){
                console.log(__('check_sumary').green, String(allCaseCount).bold, String(allCaseCount-failedCaseCount).bold, String(failedCaseCount).bold.red + colors.styles.green.open);
            }
            else{
                console.log(__('nocheck_sumary').green, String(allCaseCount).bold, __('nocheck').yellow + colors.styles.green.open);
            }
            console.log(__('test_spec_saved').green+fileName.bold);
            console.log('');
        }
    });
}


// start chrome driver
function startChromeDriver(){
    var fileName = process.platform === 'win32' ? 'chromedriver.exe' : 'chromedriver';
    fileName = path.resolve(__dirname,'../tool/'+fileName);
    fs.chmodSync(fileName, '755');
    cp.spawn(fileName, ['--url-base=wd/hub', '--port=9766'], {stdio: ['ignore']});
}

// start recorder server
function startRecorderServer(config, onReady, onCommand, onEnd){
    var serverPort = 9765;
    var server = http.createServer();
    server.listen(serverPort, function(){
        console.log('');
        console.log(__('recorder_server_listen_on').green, serverPort);
        onReady();
    });
    wsServer = new WebSocketServer({
        httpServer: server,
        autoAcceptConnections: true
    });
    wsServer.on('connect', function(connection) {
        wsConnection = connection;
        sendWsMessage('config', config);
        connection.on('message', function(message) {
            var message = message.utf8Data;
            try{
                message = JSON.parse(message);
            }
            catch(e){};
            var type = message.type;
            switch(type){
                case 'saveCmd':
                    onCommand(message.data);
                    break;
                case 'end':
                    wsConnection.close();
                    server.close(function(){
                        onEnd();
                    });
                    break;
            }
        });
        connection.on('close', function(reasonCode, description) {
            wsConnection = null;
        });
    });
}

function sendWsMessage(type, data){
    if(wsConnection){
        var message = {
            type: type,
            data: data
        };
        wsConnection.send(JSON.stringify(message));
    }
}

function newChromeBrowser(hosts, isRecorder, callback){
    var driver = new JWebDriver({
        'host': '127.0.0.1',
        'port': 9766
    });
    var capabilities = {
        'hosts': hosts
    };
    if(isRecorder){
        var crxPath = path.resolve(__dirname, '../tool/uirecorder.crx');
        var extContent = fs.readFileSync(crxPath).toString('base64');
        capabilities.chromeOptions = {
            // args:['disable-bundled-ppapi-flash', 'load-extension=E:\\github\\uirecorder\\chrome-extension']
            args: ['disable-bundled-ppapi-flash'],
            extensions: [extContent]
        };
    }
    else{
        capabilities.chromeOptions = {
            args: ['disable-bundled-ppapi-flash']
        };
    }
    driver.session(capabilities, function*(error, browser){
        if(error){
            console.log(__('chrome_init_failed').red);
            console.log(error);
            process.exit(1);
        }
        else{
            yield browser.maximize();
            yield browser.config({
                asyncScriptTimeout: 10000
            });
            yield callback(browser);
        }
    }).catch(function(e){});
}

// get local ip
function getLocalIP() {
    var ifaces = os.networkInterfaces();
    for (var dev in ifaces) {
        var iface = ifaces[dev];
        for (var i = 0; i < iface.length; i++) {
            var alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal){
                return alias.address;
            }
        }
    }
}

module.exports = startRecorder;
