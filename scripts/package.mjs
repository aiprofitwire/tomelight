/**
 * Packages Tomelight.app for macOS.
 *   node scripts/package.mjs            -> Apple Silicon (arm64)
 *   node scripts/package.mjs --x64      -> Intel Macs
 * Works from macOS or Linux. On macOS it ad-hoc signs with `codesign`;
 * elsewhere, sign afterwards with rcodesign (see README).
 */
import { packager } from '@electron/packager';
import { execSync } from 'node:child_process';
import path from 'node:path';

const arch = process.argv.includes('--x64') ? 'x64' : 'arm64';
const docTypes = [
  {
    CFBundleTypeName: 'Markdown Document',
    CFBundleTypeRole: 'Editor',
    LSHandlerRank: 'Default',
    CFBundleTypeIconFile: 'electron.icns',
    LSItemContentTypes: ['net.daringfireball.markdown', 'public.markdown'],
    CFBundleTypeExtensions: ['md', 'markdown', 'mdown', 'mkd', 'mdx'],
  },
  {
    CFBundleTypeName: 'HTML Document',
    CFBundleTypeRole: 'Editor',
    LSHandlerRank: 'Alternate',
    LSItemContentTypes: ['public.html'],
    CFBundleTypeExtensions: ['html', 'htm'],
  },
  {
    CFBundleTypeName: 'Plain Text',
    CFBundleTypeRole: 'Editor',
    LSHandlerRank: 'Alternate',
    LSItemContentTypes: ['public.plain-text'],
    CFBundleTypeExtensions: ['txt'],
  },
  {
    CFBundleTypeName: 'Folder',
    CFBundleTypeRole: 'Viewer',
    LSHandlerRank: 'Alternate',
    LSItemContentTypes: ['public.folder'],
  },
];

const out = await packager({
  dir: '.',
  out: 'release',
  name: 'Tomelight',
  executableName: 'Tomelight',
  platform: 'darwin',
  arch,
  overwrite: true,
  asar: true,
  prune: true,
  icon: 'build/icon.icns',
  appBundleId: 'com.tomelight.reader',
  appCategoryType: 'public.app-category.productivity',
  appCopyright: 'Tomelight. MIT License.',
  darwinDarkModeSupport: true,
  ignore: [/^\/src\/renderer/, /^\/test/, /^\/examples/, /^\/site/, /^\/docs/, /^\/\.github/, /^\/CHANGELOG/, /^\/release/, /^\/build\/(?!icon\.icns)/, /^\/scripts/, /^\/build\.mjs$/, /^\/node_modules/, /\.md$/, /^\/\.git/],
  extendInfo: {
    CFBundleDocumentTypes: docTypes,
    UTImportedTypeDeclarations: [{
      UTTypeIdentifier: 'net.daringfireball.markdown',
      UTTypeDescription: 'Markdown Document',
      UTTypeConformsTo: ['public.plain-text'],
      UTTypeTagSpecification: { 'public.filename-extension': ['md', 'markdown', 'mdown', 'mkd'], 'public.mime-type': 'text/markdown' },
    }],
    NSHumanReadableCopyright: 'Your docs, beautifully lit.',
    LSMinimumSystemVersion: '12.0',
  },
});
const appPath = path.join(out[0], 'Tomelight.app');
console.log('✦ packaged', appPath);
if (process.platform === 'darwin') {
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
  console.log('✦ ad-hoc signed');
}
