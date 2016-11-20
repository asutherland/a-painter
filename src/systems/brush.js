/* globals AFRAME THREE BinaryManager */
var VERSION = 1;

AFRAME.BRUSHES = {};

AFRAME.registerBrush = function (name, definition, options) {
  var proto = {};

  // Format definition object to prototype object.
  Object.keys(definition).forEach(function (key) {
    proto[key] = {
      value: definition[key],
      writable: true
    };
  });

  if (AFRAME.BRUSHES[name]) {
    throw new Error('The brush `' + name + '` has been already registered. ' +
                    'Check that you are not loading two versions of the same brush ' +
                    'or two different brushes of the same name.');
  }

  var BrushInterface = function () {};

  var defaultOptions = {
    spacing: 0,
    maxPoints: 0
  };

  BrushInterface.prototype = {
    options: Object.assign(defaultOptions, options),
    reset: function () {},
    tick: function (timeoffset, delta) {},
    addPoint: function (position, orientation, pointerPosition, pressure, timestamp) {},
    getBinary: function (system) {
      // Color = 3*4 = 12
      // NumPoints   =  4
      // Brush index =  1
      // ----------- = 21
      // [Point] = vector3 + quat + pressure + timestamp = (3+4+1+1)*4 = 36

      var bufferSize = 21 + (36 * this.data.points.length);
      var binaryManager = new BinaryManager(new ArrayBuffer(bufferSize));
      binaryManager.writeUint8(system.getUsedBrushes().indexOf(this.brushName));  // brush index
      binaryManager.writeColor(this.data.color);    // color
      binaryManager.writeFloat32(this.data.size);   // brush size

      // Number of points
      binaryManager.writeUint32(this.data.points.length);

      // Points
      for (var i = 0; i < this.data.points.length; i++) {
        var point = this.data.points[i];
        binaryManager.writeFloat32Array(point.position.toArray());
        binaryManager.writeFloat32Array(point.orientation.toArray());
        binaryManager.writeFloat32(point.pressure);
        binaryManager.writeUint32(point.timestamp);
      }
      return binaryManager.getDataView();
    }
  };

  function wrapInit (initMethod) {
    return function init (color, brushSize) {
      this.object3D = new THREE.Object3D();
      this.data = {
        points: [],
        size: brushSize,
        prevPoint: null,
        numPoints: 0,
        color: color.clone()
      };
      initMethod.call(this, color, brushSize);
    };
  }

  function wrapAddPoint (addPointMethod) {
    return function addPoint (position, orientation, pointerPosition, pressure, timestamp) {
      if ((this.data.prevPoint && this.data.prevPoint.distanceTo(position) <= this.options.spacing) ||
          this.options.maxPoints !== 0 && this.data.numPoints >= this.options.maxPoints) {
        return;
      }
      if (addPointMethod.call(this, position, orientation, pointerPosition, pressure, timestamp)) {
        this.data.numPoints++;
        this.data.points.push({
          'position': position.clone(),
          'orientation': orientation.clone(),
          'pressure': pressure,
          'timestamp': timestamp
        });

        this.data.prevPoint = position.clone();
      }
    };
  }

  var NewBrush = function () {};
  NewBrush.prototype = Object.create(BrushInterface.prototype, proto);
  NewBrush.prototype.brushName = name;
  NewBrush.prototype.constructor = NewBrush;
  NewBrush.prototype.init = wrapInit(NewBrush.prototype.init);
  NewBrush.prototype.addPoint = wrapAddPoint(NewBrush.prototype.addPoint);
  AFRAME.BRUSHES[name] = NewBrush;

  // console.log('New brush registered `' + name + '`');
  NewBrush.used = false; // Used to know which brushes have been used on the drawing
  return NewBrush;
};

AFRAME.registerSystem('brush', {
  schema: {},
  brushes: {},
  strokes: [],
  getUsedBrushes: function () {
    return Object.keys(AFRAME.BRUSHES)
      .filter(function (name) { return AFRAME.BRUSHES[name].used; });
  },
  getBrushByName: function (name) {
    return AFRAME.BRUSHES[name];
  },
  undo: function () {
    var stroke = this.strokes.pop();
    if (stroke) {
      var entity = stroke.entity;
      entity.emit('stroke-removed', {entity: entity});
      entity.parentNode.removeChild(entity);
    }
  },
  clear: function () {
    // Remove all the stroke entities
    for (var i = 0; i < this.strokes.length; i++) {
      var entity = this.strokes[i].entity;
      entity.parentNode.removeChild(entity);
    }

    // Reset the used brushes
    Object.keys(AFRAME.BRUSHES).forEach(function (name) {
      AFRAME.BRUSHES[name].used = false;
    });

    this.strokes = [];
  },
  init: function () {
    this.version = VERSION;
    this.clear();
  },
  tick: function (time, delta) {
    if (!this.strokes.length) { return; }
    for (var i = 0; i < this.strokes.length; i++) {
      this.strokes[i].tick(time, delta);
    }
  },
  generateRandomStrokes: function (numStrokes) {
    function randNeg () { return 2 * Math.random() - 1; }

    for (var l = 0; l < numStrokes; l++) {
      var brushName = 'flat';
      var color = new THREE.Color(Math.random(), Math.random(), Math.random());
      var size = Math.random() * 0.1;
      var numPoints = parseInt(Math.random() * 500);

      var stroke = this.addNewStroke(brushName, color, size);

      var position = new THREE.Vector3(randNeg(), randNeg(), randNeg());
      var aux = new THREE.Vector3();
      var orientation = new THREE.Quaternion();

      var pressure = 0.2;
      for (var i = 0; i < numPoints; i++) {
        aux.set(randNeg(), randNeg(), randNeg());
        aux.multiplyScalar(randNeg() / 20);
        orientation.setFromUnitVectors(position.clone().normalize(), aux.clone().normalize());
        position = position.add(aux);
        var timestamp = 0;

        var pointerPosition = this.getPointerPosition(position, orientation);
        stroke.addPoint(position, orientation, pointerPosition, pressure, timestamp);
      }
    }
  },
  addNewStroke: function (brushName, color, size) {
    var Brush = this.getBrushByName(brushName);
    if (!Brush) {
      var newBrushName = Object.keys(AFRAME.BRUSHES)[0];
      Brush = AFRAME.BRUSHES[newBrushName];
      console.warn('Invalid brush name: `' + brushName + '` using `' + newBrushName + '`');
    }

    Brush.used = true;
    var stroke = new Brush();
    stroke.brush = Brush;
    stroke.init(color, size);
    this.strokes.push(stroke);

    var entity = document.createElement('a-entity');
    document.querySelector('a-scene').appendChild(entity);
    entity.setObject3D('mesh', stroke.object3D);
    stroke.entity = entity;

    return stroke;
  },
  getBinary: function () {
    var dataViews = [];
    var MAGIC = 'apainter';

    // Used brushes
    var usedBrushes = this.getUsedBrushes();

    // MAGIC(8) + version (2) + usedBrushesNum(2) + usedBrushesStrings(*)
    var bufferSize = MAGIC.length + usedBrushes.join(' ').length + 9;
    var binaryManager = new BinaryManager(new ArrayBuffer(bufferSize));

    // Header magic and version
    binaryManager.writeString(MAGIC);
    binaryManager.writeUint16(VERSION);

    binaryManager.writeUint8(usedBrushes.length);
    for (var i = 0; i < usedBrushes.length; i++) {
      binaryManager.writeString(usedBrushes[i]);
    }

    // Number of strokes
    binaryManager.writeUint32(this.strokes.length);
    dataViews.push(binaryManager.getDataView());

    // Strokes
    for (i = 0; i < this.strokes.length; i++) {
      dataViews.push(this.strokes[i].getBinary(this));
    }
    return dataViews;
  },
  getPointerPosition: (function () {
    var pointerPosition = new THREE.Vector3();
    var offset = new THREE.Vector3(0, 0.7, 1);
    return function getPointerPosition (position, orientation) {
      var pointer = offset
        .clone()
        .applyQuaternion(orientation)
        .normalize()
        .multiplyScalar(-0.03);
      pointerPosition.copy(position).add(pointer);
      return pointerPosition;
    };
  })(),
  loadBinary: function (buffer) {
    var binaryManager = new BinaryManager(buffer);
    var magic = binaryManager.readString();
    if (magic !== 'apainter') {
      console.error('Invalid `magic` header');
      return;
    }

    var version = binaryManager.readUint16();
    if (version !== VERSION) {
      console.error('Invalid version: ', version, '(Expected: ' + VERSION + ')');
    }

    var numUsedBrushes = binaryManager.readUint8();
    var usedBrushes = [];
    for (var b = 0; b < numUsedBrushes; b++) {
      usedBrushes.push(binaryManager.readString());
    }

    var numStrokes = binaryManager.readUint32();

    for (var l = 0; l < numStrokes; l++) {
      var brushIndex = binaryManager.readUint8();
      var color = binaryManager.readColor();
      var size = binaryManager.readFloat();
      var numPoints = binaryManager.readUint32();

      var stroke = this.addNewStroke(usedBrushes[brushIndex], color, size);

      for (var i = 0; i < numPoints; i++) {
        var position = binaryManager.readVector3();
        var orientation = binaryManager.readQuaternion();
        var pressure = binaryManager.readFloat();
        var timestamp = binaryManager.readUint32();

        var pointerPosition = this.getPointerPosition(position, orientation);
        stroke.addPoint(position, orientation, pointerPosition, pressure, timestamp);
      }
    }
  },
  // Hacky, limited JSON support for developing brushes.  Load like so:
  // http://localhost:8080/?url=/json-scenes/line-orientations.json
  loadJSON: function(serialized) {
    if (serialized.magic !== 'apainter' || serialized.version !== 1) {
      console.error('bad a-painter JSON format');
      return;
    }

    console.log('painting JSON loaded, rendering strokes now.');
    var xRot = new THREE.Quaternion();
    var xPlaneProj = new THREE.Vector3();
    var yRot = new THREE.Quaternion();
    var yPlaneProj = new THREE.Vector3();
    var orientation = new THREE.Quaternion();
    var delta = new THREE.Vector3();
    var sideDelta = new THREE.Vector3();
    var alongController= new THREE.Vector3(0, 0, 1);

    var yFightAdjust = 0;

    for (var i = 0; i < serialized.strokes.length; i++) {
      var strokeDef = serialized.strokes[i];
      var color = new THREE.Color(strokeDef.color);
      var size = strokeDef.size || 0.2;
      var stroke = this.addNewStroke(strokeDef.brush, color, size);

      // Since we assume many things will be parallel to the ground and will use
      // sane human values which can lead to z-buffer fighting, we bump the y
      // coordinates of each stroke's coordinate by a fixed offset.  And for
      // each new independent stroke, we slightly bump that offset so that
      // there's also a conceptual z-index with later strokes covering earlier
      // strokes.
      yFightAdjust += 0.0001;

      // for orientation purposes, we want a last position.  For the base case,
      // we need to look into the future (if we have one).  We'll also negate in
      // the p=0 case to compensate for this inversion.  If there's only one
      // point, however, we'll pretend the controller is moving upwards.
      var lastPosition;
      if (strokeDef.points.length > 1) {
        lastPosition = AFRAME.utils.coordinates.toVector3(
          AFRAME.utils.coordinates.parse(strokeDef.points[1]));
        lastPosition.y += yFightAdjust;
      } else {
        lastPosition = AFRAME.utils.coordinates.toVector3(
          AFRAME.utils.coordinates.parse(strokeDef.points[0]));
        lastPosition.y -= 1; // (we'll negate, so negate here too.)
      }

      for (var p = 0; p < strokeDef.points.length; p++) {
        // for now every point is just a position
        var pointDef = strokeDef.points[p];
        var position = AFRAME.utils.coordinates.toVector3(
          AFRAME.utils.coordinates.parse(pointDef));
        position.y += yFightAdjust;

        // We imagine our controller sitting on a plane characterized by y=0
        // pointed along the z-axis.  The orientation is a quaternion describing
        // the rotation of the plane.

        // Compute the delta between the current position and the last position.
        // We imagine the controller moved along this vector, held parallel to
        // it and rotated about this axis so that it is right-side up.  (Where
        // we define right-side up as the rotation that maximizes the dot
        // product of its up/normal with the +y axis.)
        delta.subVectors(position, lastPosition);
        if (p === 0) {
          // our orientation is backwards based on our base lastPosition hack.
          delta.negate();
        }

        // Although we have the delta, we don't want to just compute the
        // rotation from the prior imaginary "+z" vector to the delta because
        // this won't maintain our up-maximizing goal.  So we decompose the
        // delta into separate rotations around +x and +y.
        xPlaneProj.set(0, delta.y, delta.z);
        xPlaneProj.normalize();
        xRot.setFromUnitVectors(alongController, xPlaneProj);

        // Vertical special-case.  Don't reset the y-rotation if this is
        // a purely vertical delta.  This provides a memory effect for us.
        // (Unfortunately, as we're implementing this, strokes that start off
        // vertical will inherit their memory of the most recent stroke segment
        // that was not purely vertical.  And if this is the first stroke
        // segment ever, things will just be informed by the zeroed quaternion.)
        if (delta.x || delta.z) {
          yPlaneProj.set(delta.x, 0, delta.z);
          yPlaneProj.normalize();
          yRot.setFromUnitVectors(alongController, yPlaneProj);
        }

        orientation.multiplyQuaternions(yRot, xRot);
        delta.normalize();

        stroke.addPoint(position, orientation, position, 1, 0);

        lastPosition = position;
      }
    }
    console.log(serialized.strokes.length, 'strokes rendered.');
  },
  loadFromUrl: function (url) {
    console.log('loading painting from', url);
    var loader = new THREE.XHRLoader(this.manager);
    loader.crossOrigin = 'anonymous';
    var isJSON = /\.json$/.test(url);
    loader.setResponseType(isJSON ? 'json' : 'arraybuffer');

    var self = this;
    loader.load(url, function (data) {
      try {
        if (isJSON) {
          self.loadJSON(data);
        } else {
          self.loadBinary(data);
        }
      } catch (ex) {
        console.error('error loading painting from URL:', ex);
      }
    });
  }
});
