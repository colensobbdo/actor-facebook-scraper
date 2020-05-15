import Apify from 'apify';
import * as moment from "moment";
import { InfoError } from './error';
import { LABELS, CSS_SELECTORS } from './constants';
import {
    getUrlLabel,
    setLanguageCodeToCookie,
    userAgents,
    normalizeOutputPageUrl,
    extractUsernameFromUrl,
    generateSubpagesFromUrl,
    stopwatch,
    executeOnDebug,
    parseRelativeDate,
} from './functions';
import {
    getPagesFromListing,
    getPageInfo,
    getPostUrls,
    getFieldInfos,
    getReviews,
    getPostContent,
    getPostComments,
    getServices,
    getPostInfoFromScript,
    isNotFoundPage,
} from './page';
import { statePersistor, emptyState } from './storage';
import type { Schema, FbLabel, FbSection } from './definitions';

import LANGUAGES = require('./languages.json');

// // eslint-disable-next-line no-extend-native
// Object.defineProperty(Array.prototype, 'flat', {
//     // eslint-disable-next-line object-shorthand
//     value: function (depth = 1) {
//         // eslint-disable-next-line prefer-arrow-callback
//         return this.reduce(function (flat: string | any[], toFlatten: any[]) {
//             return flat.concat((Array.isArray(toFlatten) && (depth > 1)) ? toFlatten.flat(depth - 1) : toFlatten);
//         }, []);
//     },
// });

const isDevelopment =
    !process.env.NODE_ENV || process.env.NODE_ENV === "development";

if (isDevelopment) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-ignore
    // @ts-ignore
    process.env.MAX_CONCURRENCY = 1;

    Apify.getInput = async function () {
        return {
            trendKey: null,
            hashtag: null,
            languageCode: "en-US",
            countryCode: "nz",
            howManyDays: 30,
            debug: true,
            startUrls: [
                {
                    url: "https://www.facebook.com/PedigreeNZ/",
                },
            ],
            commentsMode: "RANKED_UNFILTERED",
            maxPosts: 1,
            maxPostComments: 1,
            maxReviews: 1,
            scrapeAbout: false,
            scrapeReviews: true,
            scrapePosts: true,
            scrapeServices: false,
            proxyConfiguration: {
                useApifyProxy: false,
            },
        };
    };
}

const { log, puppeteer } = Apify.utils;

async function run() {
    const input: Schema | null = await Apify.getInput();

    if (!input || typeof input !== 'object') {
        throw new Error('Missing input');
    }

    const {
        trendKey = null,
        hashtag = null,
        languageCode: language = "en-US",
        countryCode = null,
        howManyDays = 3,
        debug = false,
        startUrls,
        proxyConfiguration,
        maxPosts = 3,
        // maxPostDate,
        maxPostComments = 15,
        // maxReviewDate,
        // maxCommentDate,
        maxReviews = 3,
        commentsMode = 'RANKED_THREADED',
        scrapeAbout = true,
        scrapeReviews = true,
        scrapePosts = true,
        scrapeServices = true,
        // language = 'en-US',
    } = input;

    const startDate = `${howManyDays} days`
    const maxPostDate = startDate;
    const maxCommentDate = startDate;
    const maxReviewDate = startDate;
    const languageCode = `${language}`.split("-")[0];

    if (debug || process.env.debug === "true" || isDevelopment) {
        log.setLevel(log.LEVELS.DEBUG);
    }

    if (!Array.isArray(startUrls) || !startUrls.length) {
        throw new Error('You must provide the "startUrls" input');
    }

    if (!Number.isFinite(maxPostComments)) {
        throw new Error('You must provide a finite number for "maxPostComments" input');
    }

    if (Apify.isAtHome() && !proxyConfiguration) {
        throw new Error('You must specify a proxy');
    }

    const startUrlsRequests = new Apify.RequestList({
        sources: startUrls.map((url) => {
            const opts = {
                url: typeof url === "object" ? url.url : url,
                userData: {
                    // not supported here
                    hashtag,
                    trendKey,
                    countryCode,
                    // language selected
                    languageCode,
                    // crawler type
                    crawler: "facebook",
                },
            };
            log.info("Pushing request to queue", opts);

            return opts;
        }),
    });

    await startUrlsRequests.initialize();

    if (!(language in LANGUAGES)) {
        throw new Error(`Selected language "${language}" isn't supported`);
    }

    const { map, state, persistState } = await statePersistor();
    const elapsed = stopwatch();

    log.info(`Starting crawler with ${startUrlsRequests.length()} urls`);
    log.info(`Using language "${(LANGUAGES as any)[language]}" (${language})`);

    const processedPostDate = maxPostDate ? parseRelativeDate(maxPostDate) : null;

    if (processedPostDate) {
        log.info(`Getting posts from ${new Date(processedPostDate).toISOString()} and newer`);
    }

    const processedCommentDate = maxCommentDate ? parseRelativeDate(maxCommentDate) : null;

    if (processedCommentDate) {
        log.info(`Getting comments from ${new Date(processedCommentDate).toISOString()} and newer`);
    }

    const processedReviewDate = maxReviewDate ? parseRelativeDate(maxReviewDate) : null;

    if (processedReviewDate) {
        log.info(`Getting reviews from ${new Date(processedReviewDate).toISOString()} and newer`);
    }

    const requestQueue = await Apify.openRequestQueue();

    let nextRequest;
    const processedRequests = new Set<Apify.Request>();

    // eslint-disable-next-line no-cond-assign
    while (nextRequest = await startUrlsRequests.fetchNextRequest()) {
        processedRequests.add(nextRequest);
    }

    if (!processedRequests.size) {
        throw new Error('No requests were loaded from startUrls');
    }

    const initSubPage = async (subpage: { url: string; section: FbSection }, url: string, userData: any) => {
        if (subpage.section === 'home') {
            const username = extractUsernameFromUrl(subpage.url);

            // initialize the page. if it's already initialized,
            // use the current content
            await map.append(username, async (value) => {
                return {
                    ...emptyState(),
                    ...userData,
                    pageUrl: normalizeOutputPageUrl(subpage.url),
                    '#url': subpage.url,
                    '#ref': url,
                    ...value,
                };
            });
        }

        await requestQueue.addRequest({
            url: subpage.url,
            userData: {
                ...userData,
                label: 'PAGE' as FbLabel,
                sub: subpage.section,
                ref: url,
                useMobile: true,
            },
        });
    };

    const pageInfo = [
        ...(scrapePosts ? ['posts'] : []),
        ...(scrapeAbout ? ['about'] : []),
        ...(scrapeReviews ? ['reviews'] : []),
        ...(scrapeServices ? ['services'] : []),
    ] as FbSection[];

    for (const request of processedRequests) {
        const { url, userData } = request;
        const urlType = getUrlLabel(url);

        if (urlType === 'PAGE') {
            for (const subpage of generateSubpagesFromUrl(url, pageInfo)) {
                await initSubPage(subpage, url, userData);
            }
        } else if (urlType === 'LISTING') {
            await requestQueue.addRequest({
                url,
                userData: {
                    ...userData,
                    label: urlType,
                    useMobile: false,
                },
            });
        }
    }

    const maxConcurrency = process.env?.MAX_CONCURRENCY ? +process.env.MAX_CONCURRENCY : undefined;

    const crawler = new Apify.PuppeteerCrawler({
        requestQueue,
        useSessionPool: true,
        maxRequestRetries: 5,
        // eslint-disable-next-line @typescript-eslint/ban-ts-ignore
        // @ts-ignore
        autoscaledPoolOptions: {
            // make it easier to debug locally with slowMo without switching tabs
            maxConcurrency,
        },
        puppeteerPoolOptions: {
            maxOpenPagesPerInstance: maxConcurrency,
        },
        launchPuppeteerFunction: async (options) => {
            return Apify.launchPuppeteer({
                ...options,
                slowMo: log.getLevel() === log.LEVELS.DEBUG ? 100 : undefined,
                useChrome: Apify.isAtHome(),
                stealth: true,
                args: ['--disable-dev-shm-usage', '--disable-setuid-sandbox'],
                ...proxyConfiguration,
            });
        },
        handlePageTimeoutSecs: Math.round(60 * (((maxPostComments + maxPosts) || 10) * 0.33)), // more comments, less concurrency
        gotoFunction: async ({ page, request, puppeteerPool }) => {
            await setLanguageCodeToCookie(language, page);

            await executeOnDebug(async () => {
                await page.exposeFunction('logMe', (...args) => {
                    console.log(...args);
                });
            });

            await page.exposeFunction('unhideChildren', (element?: HTMLElement) => {
                // weird bugs happen in this function, sometimes the dom element has no querySelectorAll for
                // unknown reasons
                if (!element) {
                    return;
                }

                element.className = '';
                if (typeof element.removeAttribute === 'function') {
                    // weird bug that sometimes removeAttribute isn't a function?
                    element.removeAttribute('style');
                }

                if (typeof element.querySelectorAll === 'function') {
                    for (const el of [...element.querySelectorAll<HTMLElement>('*')]) {
                        el.className = ''; // removing the classes usually unhides

                        if (typeof element.removeAttribute === 'function') {
                            el.removeAttribute('style');
                        }
                    }
                }
            });

            // make the page a little more lightweight
            await puppeteer.blockRequests(page, {
                urlPatterns: [
                    '.woff',
                    '.webp',
                    '.mov',
                    '.mpeg',
                    '.mpg',
                    '.mp4',
                    '.woff2',
                    '.ttf',
                    '.ico',
                    'scontent-',
                    'scontent.fplu',
                    'safe_image.php',
                    'static_map.php',
                    'ajax/bz',
                ],
            });

            const { userData: { useMobile } } = request;

            // listing need to start in a desktop version
            // page needs a mobile viewport
            const { data } = useMobile
                ? userAgents.mobile()
                : userAgents.desktop();

            request.userData.userAgent = data.userAgent;

            await page.emulate({
                userAgent: data.userAgent,
                viewport: {
                    height: useMobile ? 740 : 1080,
                    width: useMobile ? 360 : 1920,
                    hasTouch: useMobile,
                    isMobile: useMobile,
                    deviceScaleFactor: useMobile ? 4 : 1,
                },
            });

            try {
                log.debug(`Navigating to page ${request.url}`);
                const response = await page.goto(request.url, {
                    waitUntil: 'networkidle2',
                    timeout: 60000,
                });

                return response;
            } catch (e) {
                log.exception(e, 'gotoFunction', {
                    url: request.url,
                    userData: request.userData,
                });

                await puppeteerPool.retire(page.browser());

                return null;
            }
        },
        handlePageFunction: async ({ request, page, puppeteerPool, session }) => {
            const { userData } = request;

            const label: FbLabel = userData.label; // eslint-disable-line prefer-destructuring

            log.debug(`Visiting page ${request.url}`);

            try {
                if (userData.useMobile) {
                    // need to do some checks if the current mobile page is the interactive one or if
                    // it has been blocked
                    if (await page.$(CSS_SELECTORS.MOBILE_CAPTCHA)) {
                        throw new InfoError('Mobile captcha found', {
                            url: request.url,
                            namespace: 'captcha',
                            userData,
                        });
                    }

                    try {
                        await Promise.all([
                            page.waitForSelector(CSS_SELECTORS.MOBILE_META, {
                                timeout: 3000, // sometimes the page takes a while to load the responsive interactive version
                            }),
                            page.waitForSelector(CSS_SELECTORS.MOBILE_BODY_CLASS, {
                                timeout: 3000, // correctly detected android. if this isn't the case, the image names will change
                            }),
                        ]);
                    } catch (e) {
                        throw new InfoError('An unexpected page layout was returned by the server. This request will be retried shortly.', {
                            url: request.url,
                            namespace: 'mobile-meta',
                            userData,
                        });
                    }
                }

                if (!userData.useMobile && await page.$(CSS_SELECTORS.DESKTOP_CAPTCHA)) {
                    throw new InfoError('Desktop captcha found', {
                        url: request.url,
                        namespace: 'captcha',
                        userData,
                    });
                }

                if (label !== 'LISTING' && await isNotFoundPage(page)) {
                    request.noRetry = true;

                    // throw away if page is not available
                    // but inform the user of error
                    throw new InfoError('Content not found. This either means the page doesn\'t exist, or the section itself doesn\'t exist (about, reviews, services)', {
                        url: request.url,
                        namespace: 'isNotFoundPage',
                        userData,
                    });
                }

                if (label === LABELS.LISTING) {
                    const start = stopwatch();
                    const pagesUrls = await getPagesFromListing(page);

                    for (const url of pagesUrls) {
                        for (const subpage of generateSubpagesFromUrl(url, pageInfo)) {
                            await initSubPage(subpage, request.url, userData);
                        }
                    }

                    log.info(`Got ${pagesUrls.size} pages from listing in ${start() / 1000}s`);
                } else if (userData.label === LABELS.PAGE) {
                    const username = extractUsernameFromUrl(request.url);

                    switch (userData.sub) {
                        // Main landing page
                        case 'home':
                            await map.append(username, async (value) => {
                                const {
                                    likes,
                                    messenger,
                                    title,
                                    verified,
                                    ...address
                                } = await getPageInfo(page);

                                return getFieldInfos(page, {
                                    ...value,
                                    likes,
                                    messenger,
                                    title,
                                    verified,
                                    address: {
                                        lat: null,
                                        lng: null,
                                        ...value?.address,
                                        ...address,
                                    },
                                });
                            });
                            break;
                        // Services if any
                        case 'services':
                            try {
                                const services = await getServices(page);

                                if (services.length) {
                                    await map.append(username, async (value) => {
                                        return {
                                            ...value,
                                            services: [
                                                ...(value?.services ?? []),
                                                ...services,
                                            ],
                                        };
                                    });
                                }
                            } catch (e) {
                                // it's ok to fail here, not every page has services
                                log.debug(e.message);
                            }
                            break;
                        // About if any
                        case 'about':
                            await map.append(username, async (value) => {
                                return getFieldInfos(page, {
                                    ...value,
                                });
                            });
                            break;
                        // Posts
                        case 'posts':
                            // We don't do anything here, we enqueue posts to be
                            // read on their own phase/label
                            for (const url of await getPostUrls(page, {
                                max: maxPosts,
                                date: processedPostDate,
                                username,
                            })) {
                                if (url.url) {
                                    await requestQueue.addRequest({
                                        url: url.url,
                                        userData: {
                                            ...userData,
                                            label: LABELS.POST,
                                            useMobile: false,
                                            username,
                                            canonical: url.canonical,
                                        },
                                    });
                                }
                            }
                            break;
                        // Reviews if any
                        case 'reviews':
                            try {
                                const reviewData = await getReviews(page, {
                                    max: maxReviews,
                                    date: processedReviewDate,
                                });

                                if (reviewData) {
                                    const { average, count, reviews } = reviewData;

                                    await map.append(username, async (value) => {
                                        return {
                                            ...value,
                                            reviews: {
                                                ...(value?.reviews ?? {}),
                                                average,
                                                count,
                                                reviews: [
                                                    ...reviews,
                                                    ...(value?.reviews?.reviews ?? []),
                                                ],
                                            },
                                        };
                                    });
                                }
                            } catch (e) {
                                // it's ok for failing here, not every page has reviews
                                log.debug(e.message);
                            }
                            break;
                        // make eslint happy
                        default:
                            throw new InfoError(`Unknown subsection ${userData.sub}`, {
                                url: request.url,
                                namespace: 'handlePageFunction',
                            });
                    }
                } else if (label === LABELS.POST) {
                    const post = stopwatch();

                    log.debug('Started processing post', { url: request.url });

                    // actually parse post content here, it doesn't work on
                    // mobile address
                    const { username, canonical } = userData;

                    const [postStats, content] = await Promise.all([
                        getPostInfoFromScript(page, canonical),
                        getPostContent(page),
                    ]);

                    const postComments = await getPostComments(page, {
                        max: maxPostComments,
                        mode: commentsMode,
                        date: processedCommentDate,
                    });

                    // eslint-disable-next-line @typescript-eslint/ban-ts-ignore
                    // @ts-ignore
                    await map.append(username, (value) => {
                        return {
                            ...value,
                            posts: [
                                {
                                    ...content,
                                    postStats,
                                    postComments,
                                },
                                ...(value?.posts ?? []),
                            ],
                        };
                    });

                    log.info(`Processed post in ${post() / 1000}s`, { url: request.url });
                } else {
                    throw new InfoError(`Invalid label found ${userData.label}`, {
                        url: request.url,
                        namespace: 'handlePageFunction',
                    });
                }
            } catch (e) {
                log.debug(e.message, {
                    url: request.url,
                    userData: request.userData,
                    error: e,
                });

                session?.markBad();

                if (e instanceof InfoError) {
                    // We want to inform the rich error before throwing
                    log.warning(e.message, e.toJSON());

                    if (['captcha', 'mobile-meta', 'getFieldInfos'].includes(e.meta.namespace)) {
                        // the session is really bad
                        session?.retire();
                        await puppeteerPool.retire(page.browser());
                    }
                }

                throw e;
            }

            log.debug(`Done with page ${request.url}`);
        },
        handleFailedRequestFunction: async ({ request, error }) => {
            if (error instanceof InfoError) {
                // this only happens when maxRetries is
                // comprised mainly of InfoError, which is usually a problem
                // with pages
                log.exception(error, 'handleFailedRequestFunction', error.toJSON());
            } else {
                log.error(`Requests failed on ${request.url} after ${request.retryCount} retries`);
            }
        },
    });

    log.info('Starting dataset...');

    await crawler.run();

    await persistState();

    log.info('Generating dataset...');

    const finished = new Date().toISOString();

    // generate the dataset from all the crawled pages
    await Apify.pushData([...state.values()].filter(s => s.categories?.length).map(val => ({
        ...val,
        "#version": 2, // current data format version
        '#finishedAt': finished,
    })));

    log.info(`Done in ${Math.round(elapsed() / 60000)}m!`);
}

Apify.main(async () => {
    try {
        return await run();
    } catch (err) {
        console.error(err);
        log.error(err);
    }
});
