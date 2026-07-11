export default {
	'*.{js,cjs,mjs,vue}': ['cross-env NODE_ENV=production oxlint'],
	'*.ts': [
		'cross-env NODE_ENV=production oxlint',
		() => 'npm run type-check',
	],
};