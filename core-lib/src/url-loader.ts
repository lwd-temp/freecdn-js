class UrlLoader {
  public readonly url: string
  private readonly paramMods: ParamBase[]
  private readonly abortCtrl = new AbortController()

  private pauseSignal: PromiseX | null
  private isNetErr = false
  private isDone = false
  private isAborted = false

  public bytesRead = 0
  public onResponse: (args: ResponseArgs) => void
  public onData: (chunk: Uint8Array) => void
  public onEnd: () => void
  public onError: (err: Error) => void


  public constructor(urlConf: UrlConf, manifest: Manifest) {
    this.url = urlConf.url
    this.paramMods = urlConf.parse(manifest)
  }

  public async request(fileLoader: FileLoader) {
    let err
    try {
      err = await this.requestUnsafe(fileLoader)
    } catch (e) {
      console.assert(e instanceof ParamError)
      err = e
    }

    if (err && !this.isAborted) {
      for (const mod of this.paramMods) {
        mod.onError(err)
      }
      this.onError(err)

      // TODO: network.addError(err)

      if (!this.isNetErr) {
        this.abort(err)
      }
    }
  }

  private async requestUnsafe(fileLoader: FileLoader) {
    const {rawReq} = fileLoader
    const reqArgs: RequestArgs = {
      method: rawReq.method,
      body: rawReq.body,
      referrer: rawReq.referrer,
      referrerPolicy: 'same-origin',
      headers: new Headers(),
    }

    for (const mod of this.paramMods) {
      mod.onRequest(reqArgs, fileLoader)
    }

    reqArgs.signal = this.abortCtrl.signal

    const req = new Request(this.url, reqArgs)
    let res: Response
    try {
      res = await Network.fetch(req)
    } catch (err) {
      this.isNetErr = true
      return err
    }

    const {status} = res
    if (status !== 200) {
      return new Error('invalid http status. code: ' + status)
    }

    const resArgs: ResponseArgs = {
      status: res.status,
      statusText: res.statusText,
      headers: new Headers(),
    }
    for (const mod of this.paramMods) {
      mod.onResponse(resArgs, fileLoader, res)
    }
    this.onResponse(resArgs)

    if (!res.body) {
      return new Error('cors error')
    }
    const reader = res.body.getReader()
    let buf: Uint8Array

    READ: for (;;) {
      try {
        const {done, value} = await reader.read()
        if (!value) {
          console.assert(done)
          break
        }
        buf = value
      } catch (err) {
        this.isNetErr = true
        return err
      }

      for (const mod of this.paramMods) {
        const ret = mod.onData(buf)

        // await is slow
        // https://gist.github.com/EtherDream/52649e4939008e149d0cb3a944c055b7
        buf = ret instanceof Promise ? await ret : ret

        if (buf.length === 0) {
          continue READ
        }
      }

      if (buf.length > 0) {
        this.pauseSignal && await this.pauseSignal
        this.bytesRead += buf.length
        this.onData(buf)
      }
    } // READ NEXT

    this.isDone = true
    buf = EMPTY_BUF

    for (const mod of this.paramMods) {
      const ret = mod.onEnd(buf)
      buf = ret instanceof Promise ? await ret : ret
    }

    if (buf.length > 0) {
      this.pauseSignal && await this.pauseSignal
      this.bytesRead += buf.length
      this.onData(buf)
    }

    this.onEnd()
  }

  public pause() {
    console.assert(!this.pauseSignal)
    this.pauseSignal = promisex()
  }

  public resume() {
    this.pauseSignal?.resolve()
    this.pauseSignal = null
  }

  public abort(reason: any) {
    if (this.isDone) {
      return
    }
    this.isAborted = true
    this.abortCtrl.abort()

    for (const mod of this.paramMods) {
      mod.onAbort(reason)
    }
  }
}