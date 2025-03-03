'use strict';

const Utils = require('../../utils');
const { Transaction } = require('../../transaction');
const _ = require('lodash');
const { MySqlQueryGenerator } = require('../mysql/query-generator');
const { AbstractQueryGenerator } = require('../abstract/query-generator');

export class SqliteQueryGenerator extends MySqlQueryGenerator {
  createSchemaQuery() {
    throw new Error(`Schemas are not supported in ${this.dialect.name}.`);
  }

  dropSchemaQuery() {
    throw new Error(`Schemas are not supported in ${this.dialect.name}.`);
  }

  listSchemasQuery() {
    throw new Error(`Schemas are not supported in ${this.dialect.name}.`);
  }

  versionQuery() {
    return 'SELECT sqlite_version() as `version`';
  }

  createTableQuery(tableName, attributes, options) {
    options = options || {};

    const primaryKeys = [];
    const needsMultiplePrimaryKeys = Object.values(attributes).filter(definition => definition.includes('PRIMARY KEY')).length > 1;
    const attrArray = [];

    for (const attr in attributes) {
      if (Object.prototype.hasOwnProperty.call(attributes, attr)) {
        const dataType = attributes[attr];
        const containsAutoIncrement = dataType.includes('AUTOINCREMENT');

        let dataTypeString = dataType;
        if (dataType.includes('PRIMARY KEY')) {
          if (dataType.includes('INT')) {
            // Only INTEGER is allowed for primary key, see https://github.com/sequelize/sequelize/issues/969 (no lenght, unsigned etc)
            dataTypeString = containsAutoIncrement ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'INTEGER PRIMARY KEY';

            if (dataType.includes(' REFERENCES')) {
              dataTypeString += dataType.slice(dataType.indexOf(' REFERENCES'));
            }
          }

          if (needsMultiplePrimaryKeys) {
            primaryKeys.push(attr);
            if (dataType.includes('NOT NULL')) {
              dataTypeString = dataType.replace(' PRIMARY KEY', '');
            } else {
              dataTypeString = dataType.replace('PRIMARY KEY', 'NOT NULL');
            }
          }
        }

        attrArray.push(`${this.quoteIdentifier(attr)} ${dataTypeString}`);
      }
    }

    const table = this.quoteTable(tableName);
    let attrStr = attrArray.join(', ');
    const pkString = primaryKeys.map(pk => this.quoteIdentifier(pk)).join(', ');

    // sqlite has a bug where using CONSTRAINT constraint_name UNIQUE during CREATE TABLE
    //  does not respect the provided constraint name
    //  and uses sqlite_autoindex_ as the name of the constraint instead.
    //  CREATE UNIQUE INDEX does not have this issue, so we're using that instead
    //
    // if (options.uniqueKeys) {
    //   _.each(options.uniqueKeys, (columns, indexName) => {
    //     if (columns.customIndex) {
    //       if (typeof indexName !== 'string') {
    //         indexName = Utils.generateIndexName(tableName, columns);
    //       }
    //
    //       attrStr += `, CONSTRAINT ${
    //         this.quoteIdentifier(indexName)
    //       } UNIQUE (${
    //         columns.fields.map(field => this.quoteIdentifier(field)).join(', ')
    //       })`;
    //     }
    //   });
    // }

    if (pkString.length > 0) {
      attrStr += `, PRIMARY KEY (${pkString})`;
    }

    const sql = `CREATE TABLE IF NOT EXISTS ${table} (${attrStr});`;

    return this.replaceBooleanDefaults(sql);
  }

  addLimitAndOffset(options, model) {
    let fragment = '';
    if (options.limit != null) {
      fragment += ` LIMIT ${this.escape(options.limit, undefined, options)}`;
    } else if (options.offset) {
      // limit must be specified if offset is specified.
      fragment += ` LIMIT -1`;
    }

    if (options.offset) {
      fragment += ` OFFSET ${this.escape(options.offset, undefined, options)}`;
    }

    return fragment;
  }

  booleanValue(value) {
    return value ? 1 : 0;
  }

  /**
   * Check whether the statmement is json function or simple path
   *
   * @param   {string}  stmt  The statement to validate
   * @returns {boolean}       true if the given statement is json function
   * @throws  {Error}         throw if the statement looks like json function but has invalid token
   */
  _checkValidJsonStatement(stmt) {
    if (typeof stmt !== 'string') {
      return false;
    }

    // https://sqlite.org/json1.html
    const jsonFunctionRegex = /^\s*(json(?:_[a-z]+){0,2})\([^)]*\)/i;
    const tokenCaptureRegex = /^\s*((?:(["'`])(?:(?!\2).|\2{2})*\2)|[\s\w]+|[()+,.;-])/i;

    let currentIndex = 0;
    let openingBrackets = 0;
    let closingBrackets = 0;
    let hasJsonFunction = false;
    let hasInvalidToken = false;

    while (currentIndex < stmt.length) {
      const string = stmt.slice(currentIndex);
      const functionMatches = jsonFunctionRegex.exec(string);
      if (functionMatches) {
        currentIndex += functionMatches[0].indexOf('(');
        hasJsonFunction = true;
        continue;
      }

      const tokenMatches = tokenCaptureRegex.exec(string);
      if (tokenMatches) {
        const capturedToken = tokenMatches[1];
        if (capturedToken === '(') {
          openingBrackets++;
        } else if (capturedToken === ')') {
          closingBrackets++;
        } else if (capturedToken === ';') {
          hasInvalidToken = true;
          break;
        }

        currentIndex += tokenMatches[0].length;
        continue;
      }

      break;
    }

    // Check invalid json statement
    hasInvalidToken |= openingBrackets !== closingBrackets;
    if (hasJsonFunction && hasInvalidToken) {
      throw new Error(`Invalid json statement: ${stmt}`);
    }

    // return true if the statement has valid json function
    return hasJsonFunction;
  }

  // sqlite can't cast to datetime so we need to convert date values to their ISO strings
  _toJSONValue(value) {
    if (value instanceof Date) {
      return value.toISOString();
    }

    if (Array.isArray(value) && value[0] instanceof Date) {
      return value.map(val => val.toISOString());
    }

    return value;
  }

  handleSequelizeMethod(smth, tableName, factory, options, prepend) {
    if (smth instanceof Utils.Json) {
      return super.handleSequelizeMethod(smth, tableName, factory, options, prepend);
    }

    if (smth instanceof Utils.Cast && /timestamp/i.test(smth.type)) {
      smth.type = 'datetime';
    }

    return AbstractQueryGenerator.prototype.handleSequelizeMethod.call(this, smth, tableName, factory, options, prepend);
  }

  addColumnQuery(table, key, dataType) {
    const attributes = {};
    attributes[key] = dataType;
    const fields = this.attributesToSQL(attributes, { context: 'addColumn' });
    const attribute = `${this.quoteIdentifier(key)} ${fields[key]}`;

    const sql = `ALTER TABLE ${this.quoteTable(table)} ADD ${attribute};`;

    return this.replaceBooleanDefaults(sql);
  }

  showTablesQuery() {
    return 'SELECT name FROM `sqlite_master` WHERE type=\'table\' and name!=\'sqlite_sequence\';';
  }

  updateQuery(tableName, attrValueHash, where, options, attributes) {
    options = options || {};
    _.defaults(options, this.options);

    attrValueHash = Utils.removeNullishValuesFromHash(attrValueHash, options.omitNull, options);

    const modelAttributeMap = {};
    const values = [];
    const bind = Object.create(null);
    const bindParam = options.bindParam === undefined ? this.bindParam(bind) : options.bindParam;

    if (attributes) {
      _.each(attributes, (attribute, key) => {
        modelAttributeMap[key] = attribute;
        if (attribute.field) {
          modelAttributeMap[attribute.field] = attribute;
        }
      });
    }

    for (const key in attrValueHash) {
      const value = attrValueHash[key];

      if (value instanceof Utils.SequelizeMethod || options.bindParam === false) {
        values.push(`${this.quoteIdentifier(key)}=${this.escape(value, modelAttributeMap && modelAttributeMap[key] || undefined, { context: 'UPDATE', replacements: options.replacements })}`);
      } else {
        values.push(`${this.quoteIdentifier(key)}=${this.format(value, modelAttributeMap && modelAttributeMap[key] || undefined, { context: 'UPDATE', replacements: options.replacements }, bindParam)}`);
      }
    }

    let query;
    const whereOptions = { ...options, bindParam };

    if (options.limit) {
      query = `UPDATE ${this.quoteTable(tableName)} SET ${values.join(',')} WHERE rowid IN (SELECT rowid FROM ${this.quoteTable(tableName)} ${this.whereQuery(where, whereOptions)} LIMIT ${this.escape(options.limit, undefined, options)})`.trim();
    } else {
      query = `UPDATE ${this.quoteTable(tableName)} SET ${values.join(',')} ${this.whereQuery(where, whereOptions)}`.trim();
    }

    const result = { query };
    if (options.bindParam !== false) {
      result.bind = bind;
    }

    return result;
  }

  truncateTableQuery(tableName, options = {}) {
    return [
      `DELETE FROM ${this.quoteTable(tableName)}`,
      options.restartIdentity ? `; DELETE FROM ${this.quoteTable('sqlite_sequence')} WHERE ${this.quoteIdentifier('name')} = ${Utils.addTicks(Utils.removeTicks(this.quoteTable(tableName), '`'), '\'')};` : '',
    ].join('');
  }

  deleteQuery(tableName, where, options = {}, model) {
    _.defaults(options, this.options);

    let whereClause = this.getWhereConditions(where, null, model, options);

    if (whereClause) {
      whereClause = `WHERE ${whereClause}`;
    }

    if (options.limit) {
      whereClause = `WHERE rowid IN (SELECT rowid FROM ${this.quoteTable(tableName)} ${whereClause} LIMIT ${this.escape(options.limit, undefined, options)})`;
    }

    return `DELETE FROM ${this.quoteTable(tableName)} ${whereClause}`.trim();
  }

  attributesToSQL(attributes, options) {
    const result = {};
    for (const name in attributes) {
      const dataType = attributes[name];
      const fieldName = dataType.field || name;

      if (_.isObject(dataType)) {
        let sql = dataType.type.toString();

        if (dataType.allowNull === false) {
          sql += ' NOT NULL';
        }

        if (Utils.defaultValueSchemable(dataType.defaultValue)) {
          // TODO thoroughly check that DataTypes.NOW will properly
          // get populated on all databases as DEFAULT value
          // i.e. mysql requires: DEFAULT CURRENT_TIMESTAMP
          sql += ` DEFAULT ${this.escape(dataType.defaultValue, dataType, options)}`;
        }

        if (dataType.unique === true) {
          sql += ' UNIQUE';
        }

        if (dataType.primaryKey) {
          sql += ' PRIMARY KEY';

          if (dataType.autoIncrement) {
            sql += ' AUTOINCREMENT';
          }
        }

        if (dataType.references) {
          const referencesTable = this.quoteTable(dataType.references.model);

          let referencesKey;
          if (dataType.references.key) {
            referencesKey = this.quoteIdentifier(dataType.references.key);
          } else {
            referencesKey = this.quoteIdentifier('id');
          }

          sql += ` REFERENCES ${referencesTable} (${referencesKey})`;

          if (dataType.onDelete) {
            sql += ` ON DELETE ${dataType.onDelete.toUpperCase()}`;
          }

          if (dataType.onUpdate) {
            sql += ` ON UPDATE ${dataType.onUpdate.toUpperCase()}`;
          }

        }

        result[fieldName] = sql;
      } else {
        result[fieldName] = dataType;
      }
    }

    return result;
  }

  showIndexesQuery(tableName) {
    return `PRAGMA INDEX_LIST(${this.quoteTable(tableName)})`;
  }

  showConstraintsQuery(tableName, constraintName) {
    let sql = `SELECT sql FROM sqlite_master WHERE tbl_name='${tableName}'`;

    if (constraintName) {
      sql += ` AND sql LIKE '%${constraintName}%'`;
    }

    return `${sql};`;
  }

  removeIndexQuery(tableName, indexNameOrAttributes) {
    let indexName = indexNameOrAttributes;

    if (typeof indexName !== 'string') {
      indexName = Utils.underscore(`${tableName}_${indexNameOrAttributes.join('_')}`);
    }

    return `DROP INDEX IF EXISTS ${this.quoteIdentifier(indexName)}`;
  }

  describeTableQuery(tableName, schema, schemaDelimiter) {
    const table = {
      _schema: schema,
      _schemaDelimiter: schemaDelimiter,
      tableName,
    };

    return `PRAGMA TABLE_INFO(${this.quoteTable(this.addSchema(table))});`;
  }

  describeCreateTableQuery(tableName) {
    return `SELECT sql FROM sqlite_master WHERE tbl_name='${tableName}';`;
  }

  removeColumnQuery(tableName, attributes) {

    attributes = this.attributesToSQL(attributes);

    let backupTableName;
    if (typeof tableName === 'object') {
      backupTableName = {
        tableName: `${tableName.tableName}_backup`,
        schema: tableName.schema,
      };
    } else {
      backupTableName = `${tableName}_backup`;
    }

    const quotedTableName = this.quoteTable(tableName);
    const quotedBackupTableName = this.quoteTable(backupTableName);
    const attributeNames = Object.keys(attributes).map(attr => this.quoteIdentifier(attr)).join(', ');

    return `${this.createTableQuery(backupTableName, attributes)}`
      + `INSERT INTO ${quotedBackupTableName} SELECT ${attributeNames} FROM ${quotedTableName};`
      + `DROP TABLE ${quotedTableName};`
      + `ALTER TABLE ${quotedBackupTableName} RENAME TO ${quotedTableName};`;
  }

  _alterConstraintQuery(tableName, attributes, createTableSql) {
    let backupTableName;

    attributes = this.attributesToSQL(attributes);

    if (typeof tableName === 'object') {
      backupTableName = {
        tableName: `${tableName.tableName}_backup`,
        schema: tableName.schema,
      };
    } else {
      backupTableName = `${tableName}_backup`;
    }

    const quotedTableName = this.quoteTable(tableName);
    const quotedBackupTableName = this.quoteTable(backupTableName);
    const attributeNames = Object.keys(attributes).map(attr => this.quoteIdentifier(attr)).join(', ');

    return `${createTableSql
      .replace(`CREATE TABLE ${quotedTableName}`, `CREATE TABLE ${quotedBackupTableName}`)
      .replace(`CREATE TABLE ${quotedTableName.replace(/`/g, '"')}`, `CREATE TABLE ${quotedBackupTableName}`)
    }INSERT INTO ${quotedBackupTableName} SELECT ${attributeNames} FROM ${quotedTableName};`
      + `DROP TABLE ${quotedTableName};`
      + `ALTER TABLE ${quotedBackupTableName} RENAME TO ${quotedTableName};`;
  }

  renameColumnQuery(tableName, attrNameBefore, attrNameAfter, attributes) {

    let backupTableName;

    attributes = this.attributesToSQL(attributes);

    if (typeof tableName === 'object') {
      backupTableName = {
        tableName: `${tableName.tableName}_backup`,
        schema: tableName.schema,
      };
    } else {
      backupTableName = `${tableName}_backup`;
    }

    const quotedTableName = this.quoteTable(tableName);
    const quotedBackupTableName = this.quoteTable(backupTableName);
    const attributeNamesImport = Object.keys(attributes).map(attr => (attrNameAfter === attr ? `${this.quoteIdentifier(attrNameBefore)} AS ${this.quoteIdentifier(attr)}` : this.quoteIdentifier(attr))).join(', ');
    const attributeNamesExport = Object.keys(attributes).map(attr => this.quoteIdentifier(attr)).join(', ');

    // Temporary tables don't support foreign keys, so creating a temporary table will not allow foreign keys to be preserved
    return `${this.createTableQuery(backupTableName, attributes)
    }INSERT INTO ${quotedBackupTableName} SELECT ${attributeNamesImport} FROM ${quotedTableName};`
      + `DROP TABLE ${quotedTableName};${
        this.createTableQuery(tableName, attributes)
      }INSERT INTO ${quotedTableName} SELECT ${attributeNamesExport} FROM ${quotedBackupTableName};`
      + `DROP TABLE ${quotedBackupTableName};`;
  }

  startTransactionQuery(transaction) {
    if (transaction.parent) {
      return `SAVEPOINT ${this.quoteIdentifier(transaction.name)};`;
    }

    return `BEGIN ${transaction.options.type} TRANSACTION;`;
  }

  setIsolationLevelQuery(value) {
    switch (value) {
      case Transaction.ISOLATION_LEVELS.REPEATABLE_READ:
        return '-- SQLite is not able to choose the isolation level REPEATABLE READ.';
      case Transaction.ISOLATION_LEVELS.READ_UNCOMMITTED:
        return 'PRAGMA read_uncommitted = ON;';
      case Transaction.ISOLATION_LEVELS.READ_COMMITTED:
        return 'PRAGMA read_uncommitted = OFF;';
      case Transaction.ISOLATION_LEVELS.SERIALIZABLE:
        return '-- SQLite\'s default isolation level is SERIALIZABLE. Nothing to do.';
      default:
        throw new Error(`Unknown isolation level: ${value}`);
    }
  }

  replaceBooleanDefaults(sql) {
    return sql.replace(/DEFAULT '?false'?/g, 'DEFAULT 0').replace(/DEFAULT '?true'?/g, 'DEFAULT 1');
  }

  /**
   * Generates an SQL query that returns all foreign keys of a table.
   *
   * @param  {TableName} tableName  The name of the table.
   * @returns {string}            The generated sql query.
   * @private
   */
  getForeignKeysQuery(tableName) {
    return `PRAGMA foreign_key_list(${this.quoteTable(this.addSchema(tableName))})`;
  }

  tableExistsQuery(tableName) {
    return `SELECT name FROM sqlite_master WHERE type='table' AND name=${this.escape(this.addSchema(tableName))};`;
  }

  /**
   * Generates an SQL query to check if there are any foreign key violations in the db schema
   *
   * @param {string} tableName  The name of the table
   */
  foreignKeyCheckQuery(tableName) {
    return `PRAGMA foreign_key_check(${this.quoteTable(tableName)});`;
  }

  /**
   * Quote identifier in sql clause
   *
   * @param {string} identifier
   * @param {boolean} force
   *
   * @returns {string}
   */
  quoteIdentifier(identifier, force) {
    return Utils.addTicks(Utils.removeTicks(identifier, '`'), '`');
  }

  /**
   * Generates an SQL query that extract JSON property of given path.
   *
   * @param   {string}               column  The JSON column
   * @param   {string|Array<string>} [path]  The path to extract (optional)
   * @param   {boolean}              [isJson] The value is JSON use alt symbols (optional)
   * @returns {string}                       The generated sql query
   * @private
   */
  jsonPathExtractionQuery(column, path, isJson) {
    const quotedColumn = this.isIdentifierQuoted(column)
      ? column
      : this.quoteIdentifier(column);

    const pathStr = this.escape(['$']
      .concat(_.toPath(path))
      .join('.')
      .replace(/\.(\d+)(?:(?=\.)|$)/g, (__, digit) => `[${digit}]`));

    return `json_extract(${quotedColumn},${pathStr})`;
  }
}
