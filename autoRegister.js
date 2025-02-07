import { saveToFile, delay, readFile } from './utils/helper.js';
import log from './utils/logger.js'
import Mailjs from '@cemalgnlts/mailjs';
import banner from './utils/banner.js';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import axios from 'axios';
import {
    registerUser,
    createUserProfile,
    confirmUserReff,
    getUserRef
} from './utils/api.js';

puppeteer.use(StealthPlugin());
const mailjs = new Mailjs();

const checkIfHTML = (response) => {
    return typeof response === 'string' && response.startsWith('<!DOCTYPE');
};

const registerWithPuppeteer = async (email, password, proxy) => {
    log.info(`Using Puppeteer to register ${email}`);
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-software-rasterizer',
            proxy ? `--proxy-server=${proxy}` : ''
        ].filter(Boolean)
    });
    const page = await browser.newPage();
    try {
        await page.goto('https://api.depined.org/register', { waitUntil: 'networkidle2' });
        await page.type('#email', email);
        await page.type('#password', password);
        await page.click('#submit');
        await page.waitForNavigation();
        log.info(`Successfully registered ${email} with Puppeteer`);
    } catch (err) {
        log.error('Puppeteer registration error:', err.message);
    } finally {
        await browser.close();
    }
};

const generateEmailWithRetry = async (maxRetries = 5) => {
    let attempts = 0;
    while (attempts < maxRetries) {
        try {
            let account = await mailjs.createOneAccount();
            if (account?.data?.username) return account;
        } catch (err) {
            log.error(`Error generating email (Attempt ${attempts + 1}/${maxRetries}):`, err.message);
            if (err.message.includes("429")) {
                log.warn("Rate limit detected, increasing delay...");
                await delay(30);
            }
        }
        attempts++;
        log.warn(`Failed To Generate New Email, Retrying in 15 seconds...`);
        await delay(15);
    }
    log.error('Max retries reached with Mailjs, switching to alternative email service...');
    return await generateEmailAlternative();
};

const generateEmailAlternative = async () => {
    try {
        const response = await axios.get('https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1');
        const email = response.data[0];
        log.info(`Alternative email generated: ${email}`);
        return { data: { username: email, password: 'Tempek1233@' } };
    } catch (err) {
        log.error("Failed to generate email using alternative service:", err.message);
        throw new Error("No email service available");
    }
};

const main = async () => {
    log.info(banner);
    log.info(`Processing run auto register (CTRL + C to exit)`);
    await delay(3);
    
    const tokens = await readFile("tokens.txt");
    let proxies = await readFile("proxy.txt");
    if (!proxies.length) proxies = [null];
    
    for (let i = 0; i < 5; i++) {
        for (const token of tokens) {
            let proxyIndex = i % proxies.length;
            let proxy = proxies[proxyIndex];
            
            try {
                let response = await getUserRef(token, proxy);
                
                if (checkIfHTML(response)) {
                    log.warn('Cloudflare challenge detected, switching to Puppeteer...');
                    await delay(5);
                    continue;
                }
                
                if (!response?.data?.is_referral_active) continue;
                const reffCode = response?.data?.referral_code;
                
                if (reffCode) {
                    log.info(`Found new active referral code:`, reffCode);
                    let account;
                    try {
                        account = await generateEmailWithRetry();
                    } catch (err) {
                        log.error(err.message);
                        continue;
                    }
                    
                    const email = account.data.username;
                    const password = account.data.password;

                    log.info(`Trying to register email: ${email} using proxy: ${proxy || 'None'}`);
                    await registerWithPuppeteer(email, password, proxy);
                    
                    log.info(`Trying to create profile for ${email}`);
                    await createUserProfile(token, { step: 'username', username: email }, proxy);
                    await createUserProfile(token, { step: 'description', description: "AI Startup" }, proxy);

                    let confirm = await confirmUserReff(token, reffCode, proxy);
                    while (!confirm?.data?.token) {
                        log.warn('Failed To Confirm Referral, Retrying...');
                        await delay(3);
                        confirm = await confirmUserReff(token, reffCode, proxy);
                    }

                    await saveToFile("accounts.txt", `${email}|${password}`);
                    await saveToFile("tokens.txt", `${confirm.data.token}`);
                    await saveToFile("reffhasil.txt", `${email}|${password}|${reffCode}`);
                } else {
                    log.warn('No referral code found for this account');
                }
            } catch (err) {
                log.error('Error during registration process:', err.message);
            }
        }
    }
};

// Handle CTRL+C (SIGINT)
process.on('SIGINT', () => {
    log.warn('SIGINT received. Exiting...');
    process.exit();
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    log.error('Uncaught exception:', err);
    process.exit(1);
});

main();
