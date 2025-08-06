// huskybot-app/src/lib/blackboardScraper.ts
import { saveCourseMaterial, CourseMaterial } from './idb';

/**
 * Extracts the course name from the page's h1 tag.
 * @param doc The document object of the page to scrape.
 * @returns The course name, or null if not found.
 */
export const getCourseName = (doc: Document): string | null => {
    // Selector provided in the prompt for the course title
    const headerElement = doc.querySelector('h1.js-header-text.js-readonly-header-text');
    if (headerElement) {
        return headerElement.textContent?.trim() || null;
    }
    console.warn("Could not find course name element.");
    return null;
};

/**
 * This function is designed to be executed on a Blackboard "Course Content" page.
 * It identifies all the expandable content modules and extracts the links to materials within them.
 * 
 * NOTE: This function does not perform clicks or navigation. It assumes an external
 * mechanism will handle expanding modules and visiting the links.
 * 
 * @returns A promise that resolves when the link extraction is complete.
 */
export const scrapeCourseContentPage = async () => {
    const courseName = getCourseName(document);
    if (!courseName) {
        console.error("Aborting scrape: Course name not found on the page.");
        return;
    }

    console.log(`Starting scrape for course: ${courseName}`);

    // Selector for the module toggle buttons
    const moduleButtons = document.querySelectorAll('button[id^="learning-module-title-"]');
    console.log(`Found ${moduleButtons.length} course content modules.`);

    for (const button of Array.from(moduleButtons)) {
        console.log(`Processing module: "${button.textContent?.trim()}"`);
        
        // In a real browser automation context, you would now click the button:
        // await button.click();
        // And wait for the content to appear, e.g.:
        // await new Promise(resolve => setTimeout(resolve, 1000));

        const contentId = button.getAttribute('aria-controls');
        if (!contentId) {
            console.warn("Module button is missing 'aria-controls' attribute.", button);
            continue;
        }

        const contentElement = document.getElementById(contentId);
        if (!contentElement) {
            console.warn(`Could not find content element with id: ${contentId}. It may not be loaded in the DOM yet.`);
            continue;
        }

        // Selector for the links inside an expanded module
        const links = contentElement.querySelectorAll('a[data-analytics-id="content.item.coures.outline.document.link"]');
        
        for (const link of Array.from(links)) {
            const href = (link as HTMLAnchorElement).href;
            const title = link.textContent?.trim();

            if (href && title) {
                console.log(`Discovered material to scrape: "${title}" at URL: ${href}`);
                // In a full implementation, you would navigate to `href` and then
                // call scrapeMaterialPage on the resulting page's document.
            }
        }
    }
};

/**
 * Extracts content from a specific course material page.
 * @param doc The document object of the material page.
 * @param materialTitle The title of the material being scraped.
 * @returns A CourseMaterial object ready to be saved, or null if content is not found.
 */
export const scrapeMaterialPage = (doc: Document, materialTitle: string): Omit<CourseMaterial, 'title'> | null => {
    // Selector for the main content area
    const editor = doc.querySelector('div.ql-editor.bb-editor');
    if (!editor) {
        console.error(`Could not find content editor for material: "${materialTitle}"`);
        return null;
    }

    const content = editor.textContent?.trim() || '';
    const images: { alt: string; src: string; }[] = [];

    // Extract images from standard <img> tags
    editor.querySelectorAll('img').forEach(img => {
        if (img.src) {
            images.push({ src: img.src, alt: img.alt || 'image' });
        }
    });

    // Extract file/image attachments from the special data-bbtype divs
    editor.querySelectorAll('div[data-bbtype="attachment"]').forEach(att => {
        const href = att.getAttribute('href');
        if (href && !images.some(img => img.src === href)) {
            const dataBbFile = att.getAttribute('data-bbfile');
            let altText = "attachment";
            if (dataBbFile) {
                try {
                    const fileInfo = JSON.parse(dataBbFile);
                    altText = fileInfo.alternativeText || fileInfo.linkName || "attachment";
                } catch (e) {
                    console.error("Could not parse data-bbfile JSON", e);
                }
            }
            images.push({ src: href, alt: altText });
        }
    });

    console.log(`Extracted content and ${images.length} images for "${materialTitle}".`);
    return { content, images };
};

/**
 * Orchestrates the full scraping process for a single material page
 * and saves the result to IndexedDB.
 * @param pageUrl The URL of the material page to scrape.
 * @param materialTitle The title of the material.
 * @param courseName The name of the course this material belongs to.
 */
export const processAndSaveMaterial = async (pageUrl: string, materialTitle: string, courseName: string) => {
    // This function would fetch the page content in a real scenario
    // For example:
    // const response = await fetch(pageUrl);
    // const html = await response.text();
    // const parser = new DOMParser();
    // const doc = parser.parseFromString(html, 'text/html');

    // As we can't fetch, this is a placeholder for where the logic would go.
    console.log("processAndSaveMaterial is a placeholder and cannot fetch URLs in this environment.");
    // const materialData = scrapeMaterialPage(doc, materialTitle);
    
    // if (materialData) {
    //     await saveCourseMaterial(courseName, { title: materialTitle, ...materialData });
    // }
}; 