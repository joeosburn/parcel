// @flow

import type {FilePath} from '@parcel/types';
import type {Container, Node} from 'postcss';

import SourceMap from '@parcel/source-map';
import {Transformer} from '@parcel/plugin';
import {createDependencyLocation, isURL} from '@parcel/utils';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import semver from 'semver';

const URL_RE = /url\s*\("?(?![a-z]+:)/;
const IMPORT_RE = /@import/;

function canHaveDependencies(filePath: FilePath, code: string) {
  return !/\.css$/.test(filePath) || IMPORT_RE.test(code) || URL_RE.test(code);
}

export default new Transformer({
  canReuseAST({ast}) {
    return ast.type === 'postcss' && semver.satisfies(ast.version, '^7.0.0');
  },

  async parse({asset}) {
    // This is set by other transformers (e.g. Stylus) to indicate that it has already processed
    // all dependencies, and that the CSS transformer can skip this asset completely. This is
    // required because when stylus processes e.g. url() it replaces them with a dependency id
    // to be filled in later. When the CSS transformer runs, it would pick that up and try to
    // resolve a dependency for the id which obviously doesn't exist. Also, it's faster to do
    // it this way since the resulting CSS doesn't need to be re-parsed.
    if (asset.meta.hasDependencies === false) {
      return null;
    }

    let code = await asset.getCode();
    if (code != null && !canHaveDependencies(asset.filePath, code)) {
      return null;
    }

    return {
      type: 'postcss',
      version: '7.0.0',
      program: postcss.parse(code, {
        from: asset.filePath,
      }),
    };
  },

  async transform({asset}) {
    // Normalize the asset's environment so that properties that only affect JS don't cause CSS to be duplicated.
    // For example, with ESModule and CommonJS targets, only a single shared CSS bundle should be produced.
    asset.setEnvironment({
      context: 'browser',
      engines: {
        browsers: asset.env.engines.browsers,
      },
      minify: asset.env.minify,
    });

    // When this asset is an bundle entry, allow that bundle to be split to load shared assets separately.
    // Only set here if it is null to allow previous transformers to override this behavior.
    if (asset.isSplittable == null) {
      asset.isSplittable = true;
    }

    // Check for `hasDependencies` being false here as well, as it's possible
    // another transformer (such as PostCSSTransformer) has already parsed an
    // ast and CSSTransformer's parse was never called.
    let ast = await asset.getAST();
    if (!ast || asset.meta.hasDependencies === false) {
      return [asset];
    }

    let isDirty = false;
    ast.program.walkAtRules('import', rule => {
      let params = valueParser(rule.params);
      let [name, ...media] = params.nodes;
      let moduleSpecifier;
      if (
        name.type === 'function' &&
        name.value === 'url' &&
        name.nodes.length
      ) {
        name = name.nodes[0];
      }

      moduleSpecifier = name.value;

      if (!moduleSpecifier) {
        throw new Error('Could not find import name for ' + rule);
      }

      if (isURL(moduleSpecifier)) {
        name.value = asset.addURLDependency(moduleSpecifier, {
          loc: createDependencyLocation(
            rule.source.start,
            moduleSpecifier,
            0,
            8,
          ),
        });
      } else {
        // If this came from an inline <style> tag, don't inline the imported file. Replace with the correct URL instead.
        // TODO: run CSSPackager on inline style tags.
        // let inlineHTML =
        //   this.options.rendition && this.options.rendition.inlineHTML;
        // if (inlineHTML) {
        //   name.value = asset.addURLDependency(dep, {loc: rule.source.start});
        //   rule.params = params.toString();
        // } else {
        media = valueParser.stringify(media).trim();
        let dep = {
          moduleSpecifier,
          // Offset by 8 as it does not include `@import `
          loc: createDependencyLocation(
            rule.source.start,
            moduleSpecifier,
            0,
            8,
          ),
          meta: {
            media,
          },
        };
        asset.addDependency(dep);
        rule.remove();
        // }
      }
      isDirty = true;
    });

    ast.program.walkDecls(decl => {
      if (URL_RE.test(decl.value)) {
        let parsed = valueParser(decl.value);
        let isDeclDirty = false;

        parsed.walk(node => {
          if (
            node.type === 'function' &&
            node.value === 'url' &&
            node.nodes.length > 0 &&
            !node.nodes[0].value.startsWith('#') // IE's `behavior: url(#default#VML)`
          ) {
            let url = asset.addURLDependency(node.nodes[0].value, {
              loc: createDependencyLocation(
                decl.source.start,
                node.nodes[0].value,
              ),
            });
            isDeclDirty = node.nodes[0].value !== url;
            node.nodes[0].value = url;
          }
        });

        if (isDeclDirty) {
          decl.value = parsed.toString();
          isDirty = true;
        }
      }
    });

    if (isDirty) {
      asset.setAST(ast);
    }

    return [asset];
  },

  async generate({asset, ast}) {
    let root = ast.program;

    // $FlowFixMe
    if (Object.getPrototypeOf(ast.program) === Object.prototype) {
      root = postcss.root(ast.program);
      let convert = (parent: Container, node: Node, index: number) => {
        let type = node.type === 'atrule' ? 'atRule' : node.type;
        let result = postcss[type](node);
        result.parent = parent;
        if (parent) {
          parent.nodes[index] = result;
        }

        if (result.walk) {
          // $FlowFixMe
          const container = (result: Container);
          container.each((node, index) => {
            convert(container, node, index);
          });
        }
      };

      root.each((node, index) => convert(root, node, index));
    }

    let result = await postcss().process(root, {
      from: asset.filePath,
      map: {
        annotation: false,
        inline: false,
      },
      // Pass postcss's own stringifier to it to silence its warning
      // as we don't want to perform any transformations -- only generate
      stringifier: postcss.stringify,
    });

    let map;
    if (result.map != null) {
      map = new SourceMap();
      let {mappings, sources, names} = result.map.toJSON();
      map.addRawMappings(mappings, sources, names);
    }

    return {
      content: result.css,
      map,
    };
  },
});
