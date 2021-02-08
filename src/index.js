const
    fs = require("fs"),
    path = require("path"),
    https = require("https"),
    spawnSync = require("child_process").spawnSync

class Publisher {
    constructor() {
        this.nugetSource = process.env.INPUT_NUGET_SOURCE || this._printErrorAndBail("Nuget Source Required")
        this.nugetKey = process.env.INPUT_NUGET_KEY || this._printErrorAndBail("Nuget Key Required")
        this.buildSymbolsString = (process.env.INPUT_INCLUDE_SYMBOLS || "false").toLowerCase() === "true"
            ? " --include-symbols -p:SymbolPackageFormat=snupkg "
            : ""
        this.publishSymbolsString = (process.env.INPUT_INCLUDE_SYMBOLS || "false").toLowerCase() === "true"
            ? " -n 1 "
            : ""
        this.projectFiles = process.env.INPUT_PROJECT_FILE_PATHS.split(`,`)
        this.versionRegex = new RegExp(process.env.INPUT_VERSION_REGEX || '^\s*<Version>(.*)<\/Version>\s*$')
        this.projectVersions = {}
        this.requiresPublishing = []
    }

    _printErrorAndBail(message){
        console.log(`##[error]🛑 ${message}`)
        throw new Error(message);
    }

    _checkIfProjectExists(projectFilePath){
        if (!fs.existsSync(projectFilePath)){
            console.log(process.cwd())
            fs.readdirSync(process.cwd()).forEach(file => {
                console.log(`-> ${file}`);
            });
            this._printErrorAndBail(`Unable to find project '${projectFilePath}'`)
        }
    }

    _getPackageName(projectFilePath) {
        return path
            .basename(projectFilePath)
            .split(`.`)
            .slice(0,-1)
            .join(`.`)
    }

    _runCommand(cmd, options) {
        console.log(`executing command: [${cmd}]`)

        const input = cmd.split(" ");
        const tool = input[0];
        const args = input.slice(1)

        return spawnSync(tool, args, options)
    }

    _runCommandInProcess(cmd) {
        this._runCommand(cmd, {
            encoding: "utf-8",
            stdio: [process.stdin, process.stdout, process.stderr]
        })
    }


    _getVersionExists(projectFilePath) {
        const packageName = this._getPackageName(projectFilePath);
        const thisVersion = this.projectVersions[projectFilePath]

        https.get(`${this.nugetSource}/v3-flatcontainer/${packageName}/index.json`, res => {

            if (res.statusCode === 404) {
                return false
            }

            let body = "";
            if (res.statusCode === 200) {
                res.setEncoding("utf-8")
                res.on("data", chunk => body += chunk)
                res.on("end", () => {
                    const remoteVersions = JSON.parse(body)
                    return 0 > remoteVersions["versions"].indexOf(thisVersion)
                })
            }

            this._printErrorAndBail(`unable to determine remote version for '${packageName}'`)
        }).on("error", err =>{
            this._printErrorAndBail(`unable to determine remote version for '${packageName}': ${err.message}`)
        })
    }

    run() {
        // ensure project file(s) have been passed in correctly
        if (!this.projectFiles || this.projectFiles.length === 0) {
            this._printErrorAndBail(`project files not set or improperly set`)
        }

        // ensure project file(s) exist
        this.projectFiles.forEach(pf => {
            this._checkIfProjectExists(pf)
        })

        // get projectFileVersions
        this.projectFiles.forEach(pf => {
            fs.readFile(pf, "utf-8",(err, data) => {
                if (err) {
                    this._printErrorAndBail(err.message)
                }

                let m;
                if ((m = this.versionRegex.exec(data)) !== null) {
                    this.projectVersions[pf] = m[0]
                    console.log(`Found version ${m[0]} for '${pf}'`)
                } else {
                    console.log(data)
                    this._printErrorAndBail(`unable to determine version for '${pf}' using regex ${this.versionRegex.toString()}`)
                }
            })
        })

        // determine which project(s) need published
        this.projectFiles.forEach(pf => {
            if (!this._getVersionExists()) {
                this.requiresPublishing.append(pf)
            }
        })

        // start build process
        this.requiresPublishing.forEach(pf => {
            const packageName = this._getPackageName(pf)
            const packageVersion = this.projectVersions[pf];

            console.log(`🏭 Starting build process for ${packageName} version ${packageVersion}`)

            try{
                fs.readdirSync(".")
                    .filter(f => /\.s?nupkg$/.test(f))
                    .forEach(x => fs.unlinkSync(x))

                this._runCommandInProcess(`dotnet build -c Release ${pf}`)
                this._runCommandInProcess(`dotnet pack${this.buildSymbolsString} --no-build -c Release ${pf} -o`)
            } catch (err) {
                this._printErrorAndBail(`error building package ${packageName} version ${packageVersion}: ${err.message}`)
            }
        })

        // push to server
        const packages = fs.readdirSync(".")
            .filter(f => f.endsWith("nupkg"));

        console.log(`🚀 Sending packages... (${packages.join(", ")})`)

        const pushCommand = `dotnet nuget push *.nupkg -s ${this.nugetSource}/v3/index.json -k ${this.nugetKey} --skipDuplicate${this.publishSymbolsString}`
        const pushResults = this._runCommand(pushCommand, {encoding: "utf-8"}).stdout

        console.log(pushResults)

        if(/error/.test(pushResults)) {
            this._printErrorAndBail(`${/error.*/.exec(pushResults)[0]}`)
        }
    }
}

new Publisher().run()
