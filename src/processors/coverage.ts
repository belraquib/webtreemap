import path from 'path';
import {promises as fs, statSync} from 'fs';
import {ProcessorFn, readFromFiles} from '../util';
import {getFiles} from './du';
import {XMLParser} from 'fast-xml-parser';

async function processXml(xmlPath: string, fileSizes: [string, number, number?][]) {
    const parser = new XMLParser({ignoreAttributes: false});
    const content = await readFromFiles([xmlPath]);
    const parsed = parser.parse(content).coverage;
    const prefix = parsed.sources.source;
    const ptrs = new Map<string, [string, number, number?]>();
    for (const data of fileSizes) {
        ptrs.set(data[0], data);
    }

    for (const parsedPackage of parsed.packages.package) {
        for (const parsedClass of parsedPackage.classes.class) {
            const fullPath = path.join(prefix, parsedClass['@_filename']);
            const data = ptrs.get(fullPath);
            if (!data) {
                // we have coverage for a file that's not on disk...
                continue;
            }
            data[2] = parseFloat(parsedClass['@_line-rate']);
            if (data[0].includes('/buildings/')) {
                console.log(data[0], data[2]);
            }
        }
    }
}

export const processCoverage: ProcessorFn = async args => {
    const srcPath = args[0];
    const xml = args[1];
    const fileSizes = (await getFiles(srcPath)).filter((pathInfo)=> {
        const fileName = pathInfo[0];
        if (fileName.includes('__tests__') ||
            fileName.includes('__stories__') ||
            fileName.includes('/node_modules/')) {
            return false;
        }

        return ['.cc', '.py', '.ts', '.tsx'].includes(path.extname(fileName))
    });
    await processXml(xml, fileSizes);
    return fileSizes;
};
