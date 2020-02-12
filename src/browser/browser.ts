import * as os from 'os';
import * as puppeteer from 'puppeteer';
import { Browser as PuppeteerBrowser, Page } from 'puppeteer';
import uniqueFilename = require('unique-filename');
import * as boom from '@hapi/boom';
import { Logger } from '../logger';
import { RenderingConfig } from '../config';

const allowedFormats: string[] = ['png', 'jpeg', 'pdf'];

export interface RenderOptions {
  url: string;
  width: string | number;
  height: string | number;
  filePath: string;
  timeout: string | number;
  renderKey: string;
  domain: string;
  timezone?: string;
  encoding?: string;
  jsonData?: any;
}

export interface RenderResponse {
  filePath: string;
}

export interface BrowserTimings {
  launch(callback: () => Promise<PuppeteerBrowser>): Promise<PuppeteerBrowser>;
  newPage(callback: () => Promise<Page>): Promise<Page>;
  navigate(callback: () => Promise<void>): Promise<void>;
  panelsRendered(callback: () => Promise<void>): Promise<void>;
  screenshot(callback: () => Promise<void>): Promise<void>;
  pdf(callback: () => Promise<void>): Promise<void>;
}

export class NoOpBrowserTiming {
  async launch(callback: () => Promise<PuppeteerBrowser>) {
    return await callback();
  }

  async newPage(callback: () => Promise<void>) {
    return await callback();
  }

  async navigate(callback: () => Promise<void>) {
    return await callback();
  }

  async panelsRendered(callback: () => Promise<void>) {
    return await callback();
  }

  async screenshot(callback: () => Promise<void>) {
    return await callback();
  }

  async pdf(callback: () => Promise<void>) {
    return await callback();
  }
}

export class Browser {
  constructor(protected config: RenderingConfig, protected log: Logger, protected timings: BrowserTimings) {}

  async getBrowserVersion(): Promise<string> {
    const launcherOptions = this.getLauncherOptions({});
    const browser = await puppeteer.launch(launcherOptions);
    return browser.version();
  }

  async start(): Promise<void> {}

  validateOptions(options: RenderOptions) {
    options.width = parseInt(options.width as string, 10) || 1000;
    options.height = parseInt(options.height as string, 10) || 500;
    options.timeout = parseInt(options.timeout as string, 10) || 30;

    if (options.width > 3000 || options.width < 10) {
      options.width = 2500;
    }

    if (options.height > 3000 || options.height < 10) {
      options.height = 1500;
    }

    if (options.encoding === '') {
      options.encoding = 'png';
    }

    if (allowedFormats.indexOf(options.encoding as string) === -1) {
      throw boom.badRequest('Unsupported encoding ' + options.encoding);
    }

    if (options.jsonData) {
      options.jsonData = JSON.parse(options.jsonData);
    } else {
      options.jsonData = {};
    }
  }

  getLauncherOptions(options) {
    this.log.debug('LauncherOptions', 'jsonData', options.jsonData);

    const env = Object.assign({}, process.env);
    // set env timezone
    env.TZ = options.timezone || this.config.timezone;

    const launcherOptions: any = {
      env: env,
      ignoreHTTPSErrors: this.config.ignoresHttpsErrors,
      args: ['--no-sandbox'],
      ...(options.jsonData ? options.jsonData.launchOptions : null),
    };

    if (this.config.chromeBin) {
      launcherOptions.executablePath = this.config.chromeBin;
    }

    return launcherOptions;
  }

  async render(options: RenderOptions): Promise<RenderResponse> {
    let browser;
    let page: any;

    try {
      this.validateOptions(options);
      const launcherOptions = this.getLauncherOptions(options);

      browser = await this.timings.launch(
        async () =>
          // launch browser
          await puppeteer.launch(launcherOptions)
      );
      page = await this.timings.newPage(
        async () =>
          // open a new page
          await browser.newPage()
      );

      this.addPageListeners(page);

      return await this.takeScreenshot(page, options);
    } finally {
      if (page) {
        this.removePageListeners(page);
        await page.close();
      }
      if (browser) {
        await browser.close();
      }
    }
  }

  async takeScreenshot(page: any, options: any): Promise<RenderResponse> {
    await page.setViewport({
      width: options.width,
      height: options.height,
      ...options.jsonData.viewport,
    });

    if (options.jsonData.emulateMedia) {
      await page.emulateMedia(options.jsonData.emulateMedia);
    }

    if (options.jsonData.defaultNavigationTimeout) {
      await page.setDefaultNavigationTimeout(options.jsonData.defaultNavigationTimeout);
    }

    await page.setCookie({
      name: 'renderKey',
      value: options.renderKey,
      domain: options.domain,
    });

    // build url
    let url = options.url + (options.jsonData.extraUrlParams ? options.jsonData.extraUrlParams : '');
    this.log.debug('Goto', 'url', url);

    await this.timings.navigate(async () => {
      // wait until all data was loaded
      await page.goto(url, { waitUntil: 'networkidle0' });
    });

    // extra javascript
    if (options.jsonData.scriptTags instanceof Array) {
      for (let val of options.jsonData.scriptTags) {
        await page.addScriptTag(val);
      }
    }

    // extra style tags
    if (options.jsonData.styleTags instanceof Array) {
      for (let val of options.jsonData.styleTags) {
        await page.addStyleTag(val);
      }
    }

    await this.timings.panelsRendered(async () => {
      // wait for all panels to render
      await page.waitForFunction(
        () => {
          const panelCount = document.querySelectorAll('.panel').length || document.querySelectorAll('.panel-container').length;
          return (window as any).panelsRendered >= panelCount;
        },
        {
          timeout: options.timeout * 1000,
        }
      );
    });

    // extra wait
    if (options.jsonData.waitFor) {
      await page.waitFor(options.jsonData.waitFor);
    }

    if (!options.filePath) {
      options.filePath = uniqueFilename(os.tmpdir()) + '.' + options.encoding;
    }

    if (options.encoding === 'pdf') {
      await this.timings.pdf(async () => {
        await page.pdf({ path: options.filePath, ...options.jsonData.pdf });
      });
    } else {
      await this.timings.screenshot(async () => {
        await page.screenshot({ path: options.filePath });
      });
    }

    return { filePath: options.filePath };
  }

  addPageListeners(page: any) {
    page.on('error', this.logError.bind);
    page.on('pageerror', this.logPageError);
    page.on('requestfailed', this.logRequestFailed);
    page.on('console', this.logConsoleMessage);

    if (this.config.verboseLogging) {
      page.on('request', this.logRequest);
      page.on('requestfinished', this.logRequestFinished);
      page.on('close', this.logPageClosed);
    }
  }

  removePageListeners(page: any) {
    page.removeListener('error', this.logError);
    page.removeListener('pageerror', this.logPageError);
    page.removeListener('requestfailed', this.logRequestFailed);
    page.removeListener('console', this.logConsoleMessage);

    if (this.config.verboseLogging) {
      page.removeListener('request', this.logRequest);
      page.removeListener('requestfinished', this.logRequestFinished);
      page.removeListener('close', this.logPageClosed);
    }
  }

  logError = (err: Error) => {
    this.log.error('Browser page crashed', 'error', err.toString());
  };

  logPageError = (err: Error) => {
    this.log.error('Browser uncaught exception', 'error', err.toString());
  };

  logConsoleMessage = (msg: any) => {
    const msgType = msg.type();
    if (!this.config.verboseLogging && msgType !== 'error') {
      return;
    }

    const loc = msg.location();
    if (msgType === 'error') {
      this.log.error('Browser console error', 'msg', msg.text(), 'url', loc.url, 'line', loc.lineNumber, 'column', loc.columnNumber);
      return;
    }

    this.log.debug(`Browser console ${msgType}`, 'msg', msg.text(), 'url', loc.url, 'line', loc.lineNumber, 'column', loc.columnNumber);
  };

  logRequest = (req: any) => {
    this.log.debug('Browser request', 'url', req._url, 'method', req._url);
  };

  logRequestFailed = (req: any) => {
    this.log.error('Browser request failed', 'url', req._url, 'method', req._method);
  };

  logRequestFinished = (req: any) => {
    this.log.debug('Browser request finished', 'url', req._url, 'method', req._method);
  };

  logPageClosed = () => {
    this.log.debug('Browser page closed');
  };
}
