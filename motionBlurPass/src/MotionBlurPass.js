/**
 * @author Garrett Johnson / http://gkjohnson.github.io/
 *
 *  Approach from http://john-chapman-graphics.blogspot.com/2013/01/per-object-motion-blur.html
 */
import {
	Frustum,
	Color,
	WebGLRenderTarget,
	LinearFilter,
	RGBFormat,
	HalfFloatType,
	Matrix4,
	DataTexture,
	RGBAFormat,
	FloatType,
	ShaderMaterial
} from '//unpkg.com/three@0.112.0/build/three.module.js';
import { Pass } from '//unpkg.com/three@0.112.0/examples/jsm/postprocessing/Pass.js';
import { VelocityShader } from './VelocityShader.js';
import { GeometryShader } from './GeometryShader.js';
import { CompositeShader } from './CompositeShader.js';

const _prevClearColor = new Color();
const _blackColor = new Color( 0, 0, 0 );
const _defaultOverrides = {};

function traverseVisibleMeshes( obj, callback ) {

	if ( obj.visible ) {

		if ( obj.isMesh || obj.isSkinnedMesh ) {

			callback( obj );

		}

		const children = obj.children;
		for ( let i = 0, l = children.length; i < l; i ++ ) {

			traverseVisibleMeshes( children[ i ], callback );

		}

	}

}

export class MotionBlurPass extends Pass {

	get enabled() {

		return this._enabled;

	}

	set enabled( val ) {

		if ( val === false ) {

			this._prevPosMap.clear();
			this._cameraMatricesNeedInitializing = true;

		}

		this._enabled = val;

	}

	constructor( scene, camera, options = {} ) {

		super();

		this.enabled = true;
		this.needsSwap = true;

		// settings
		this.samples = 'samples' in options ? options.samples : 15;
		this.expandGeometry = 'expandGeometry' in options ? options.expandGeometry : 0;
		this.interpolateGeometry = 'interpolateGeometry' in options ? options.interpolateGeometry : 1;
		this.smearIntensity = 'smearIntensity' in options ? options.smearIntensity : 1;
		this.blurTransparent = 'blurTransparent' in options ? options.blurTransparent : false;
		this.renderCameraBlur = 'renderCameraBlur' in options ? options.renderCameraBlur : true;
		this.renderTargetScale = 'renderTargetScale' in options ? options.renderTargetScale : 1;

		this.debug = {

			display: MotionBlurPass.DEFAULT,
			dontUpdateState: false

		};

		this.scene = scene;
		this.camera = camera;

		// list of positions from previous frames
		this._prevPosMap = new Map();
		this._currentFrameMod = 0;
		this._frustum = new Frustum();
		this._projScreenMatrix = new Matrix4();
		this._cameraMatricesNeedInitializing = true;

		this._prevCamProjection = new Matrix4();
		this._prevCamWorldInverse = new Matrix4();

		// render targets
		this._velocityBuffer =
			new WebGLRenderTarget( 256, 256, {
				minFilter: LinearFilter,
				magFilter: LinearFilter,
				format: RGBFormat,
				type: HalfFloatType
			} );
		this._velocityBuffer.texture.name = "MotionBlurPass.Velocity";
		this._velocityBuffer.texture.generateMipmaps = false;

		this._compositeMaterial = new ShaderMaterial( CompositeShader );
		this._compositeQuad = new Pass.FullScreenQuad( this._compositeMaterial );

	}

	// Pass API
	dispose() {

		this._compositeQuad.dispose();
		this._velocityBuffer.dispose();
		this._prevPosMap.clear();

	}

	setSize( width, height ) {

		const renderTargetScale = this.renderTargetScale;
		const velocityBuffer = this._velocityBuffer;
		velocityBuffer.setSize( width * renderTargetScale, height * renderTargetScale );

	}

	render( renderer, writeBuffer, readBuffer, delta, maskActive ) {

		const debug = this.debug;
		const velocityBuffer = this._velocityBuffer;
		const renderToScreen = this.renderToScreen;
		const scene = this.scene;
		const camera = this.camera;
		const compositeQuad = this._compositeQuad;

		// Set the clear state
		const prevClearAlpha = renderer.getClearAlpha();
		const prevAutoClear = renderer.autoClear;
		const prevRenderTarget = renderer.getRenderTarget();
		_prevClearColor.copy( renderer.getClearColor() );

		renderer.autoClear = false;
		renderer.setClearColor( _blackColor, 0 );

		// TODO: This is getting called just to set 'currentRenderState' in the renderer
		renderer.compile( scene, camera );

		// If we're rendering the blurred view, then we need to render
		// to the velocity buffer, otherwise we can render a debug view
		if ( debug.display === MotionBlurPass.DEFAULT ) {

			renderer.setRenderTarget( velocityBuffer );

		} else {

			renderer.setRenderTarget( renderToScreen ? null : writeBuffer );

		}
		renderer.clear();

		// Traversal function for iterating down and rendering the scene
		this._ensurePrevCameraTransform();
		this._drawAllMeshes(
			renderer,
			debug.display === MotionBlurPass.GEOMETRY ? MotionBlurPass.GEOMETRY : MotionBlurPass.VELOCITY,
			! debug.dontUpdateState
		);

		this._prevCamWorldInverse.copy( camera.matrixWorldInverse );
		this._prevCamProjection.copy( camera.projectionMatrix );

		// compose the final blurred frame
		if ( debug.display === MotionBlurPass.DEFAULT ) {

			const compositeMaterial = this._compositeMaterial;
			const uniforms = compositeMaterial.uniforms;
			uniforms.sourceBuffer.value = readBuffer.texture;
			uniforms.velocityBuffer.value = this._velocityBuffer.texture;

			if ( compositeMaterial.defines.SAMPLES !== this.samples ) {

				compositeMaterial.defines.SAMPLES = Math.max( 0, Math.floor( this.samples ) );
				compositeMaterial.needsUpdate = true;

			}

			renderer.setRenderTarget( this.renderToScreen ? null : writeBuffer );
			compositeQuad.render( renderer );
			renderer.setRenderTarget( null );

		}

		// Restore renderer settings
		renderer.setClearColor( _prevClearColor, prevClearAlpha );
		renderer.setRenderTarget( prevRenderTarget );
		renderer.autoClear = prevAutoClear;

	}

	// Returns the set of previous frames data for object position and bone state. Creates
	// a new object this with frames state if it hasn't been created yet.
	_getPreviousFrameState( obj ) {

		const prevPosMap = this._prevPosMap;
		let data = prevPosMap.get( obj );
		if ( data === undefined ) {

			data = {

				lastUsedFrame: - 1,
				matrixWorld: obj.matrixWorld.clone(),
				geometryMaterial: new ShaderMaterial( GeometryShader ),
				velocityMaterial: new ShaderMaterial( VelocityShader ),
				boneMatrices: null,
				boneTexture: null,

			};
			prevPosMap.set( obj, data );

		}

		const isSkinned = obj.type === 'SkinnedMesh' && obj.skeleton && obj.skeleton.bones && obj.skeleton.boneMatrices;

		data.geometryMaterial.skinning = isSkinned;
		data.velocityMaterial.skinning = isSkinned;

		// copy the skeleton state into the prevBoneTexture uniform
		const skeleton = obj.skeleton;
		const boneTextureNeedsUpdate = data.boneMatrices === null || data.boneMatrices.length !== skeleton.boneMatrices.length;
		if ( isSkinned && boneTextureNeedsUpdate ) {

			const boneMatrices = new Float32Array( skeleton.boneMatrices.length );
			boneMatrices.set( skeleton.boneMatrices );
			data.boneMatrices = boneMatrices;

			const size = Math.sqrt( skeleton.boneMatrices.length / 4 );
			const boneTexture = new DataTexture( boneMatrices, size, size, RGBAFormat, FloatType );
			boneTexture.needsUpdate = true;

			data.geometryMaterial.uniforms.prevBoneTexture.value = boneTexture;
			data.velocityMaterial.uniforms.prevBoneTexture.value = boneTexture;
			data.boneTexture = boneTexture;

		}

		return data;

	}

	// saves the current state to be used next frame
	_saveCurrentObjectState( obj ) {

		const prevPosMap = this._prevPosMap;
		const data = prevPosMap.get( obj );

		if ( data.boneMatrices !== null ) {

			data.boneMatrices.set( obj.skeleton.boneMatrices );
			data.boneTexture.needsUpdate = true;

		}

		data.matrixWorld.copy( obj.matrixWorld );

	}

	// Draw all meshes in the scene and discard those that are no longer being used
	_drawAllMeshes( renderer, type, saveState ) {

		this._currentFrameMod = ( this._currentFrameMod + 1 ) % 2;
		const thisFrameId = this._currentFrameMod;
		const prevPosMap = this._prevPosMap;

		traverseVisibleMeshes( this.scene, mesh => {

			this._drawMesh( renderer, mesh, type, saveState );
			if ( prevPosMap.has( mesh ) ) {

				prevPosMap.get( mesh ).lastUsedFrame = thisFrameId;

			}

		} );

		prevPosMap.forEach( ( data, mesh ) => {

			if ( data.lastUsedFrame !== thisFrameId ) {

				data.geometryMaterial.dispose();
				data.velocityMaterial.dispose();
				if ( data.boneTexture ) {

					data.boneTexture.dispose();

				}
				prevPosMap.delete( mesh );

			}

		} );

	}


	_drawMesh( renderer, mesh, type, saveState ) {

		const overrides = mesh.motionBlur || _defaultOverrides;
		let blurTransparent = this.blurTransparent;
		let renderCameraBlur = this.renderCameraBlur;
		let expandGeometry = this.expandGeometry;
		let interpolateGeometry = this.interpolateGeometry;
		let smearIntensity = this.smearIntensity;

		blurTransparent = 'blurTransparent' in overrides ? overrides.blurTransparent : this.blurTransparent;
		renderCameraBlur = 'renderCameraBlur' in overrides ? overrides.renderCameraBlur : this.renderCameraBlur;
		expandGeometry = 'expandGeometry' in overrides ? overrides.expandGeometry : this.expandGeometry;
		interpolateGeometry = 'interpolateGeometry' in overrides ? overrides.interpolateGeometry : this.interpolateGeometry;
		smearIntensity = 'smearIntensity' in overrides ? overrides.smearIntensity : this.smearIntensity;

		const isTransparent = mesh.material.transparent || mesh.material.alpha < 1;
		const isCulled = mesh.frustumCulled && ! this._frustum.intersectsObject( mesh );
		let skip = blurTransparent === false && isTransparent || isCulled;

		if ( skip ) {

			if ( this._prevPosMap.has( mesh ) && saveState ) {

				this._saveCurrentObjectState( mesh );

			}

		} else {

			const camera = this.camera;
			const data = this._getPreviousFrameState( mesh );

			const material = type === MotionBlurPass.GEOMETRY ? data.geometryMaterial : data.velocityMaterial;
			const uniforms = material.uniforms;
			uniforms.expandGeometry.value = expandGeometry;
			uniforms.interpolateGeometry.value = interpolateGeometry;
			uniforms.smearIntensity.value = smearIntensity;

			const projMat = renderCameraBlur ? this._prevCamProjection : camera.projectionMatrix;
			const invMat = renderCameraBlur ? this._prevCamWorldInverse : camera.matrixWorldInverse;
			uniforms.prevProjectionMatrix.value.copy( projMat );
			uniforms.prevModelViewMatrix.value.multiplyMatrices( invMat, data.matrixWorld );

			renderer.renderBufferDirect( camera, null, mesh.geometry, material, mesh, null );

			if ( saveState ) {

				this._saveCurrentObjectState( mesh );

			}

		}

	}

	_ensurePrevCameraTransform() {

		const camera = this.camera;
		const projScreenMatrix = this._projScreenMatrix;

		// reinitialize the camera matrices to the current transform because if
		// the pass has been disabled then the matrices will be out of date
		if ( this._cameraMatricesNeedInitializing ) {

			this._prevCamWorldInverse.copy( camera.matrixWorldInverse );
			this._prevCamProjection.copy( camera.projectionMatrix );
			this._cameraMatricesNeedInitializing = false;

		}


		projScreenMatrix.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse );
		this._frustum.setFromMatrix( projScreenMatrix );

	}

}

MotionBlurPass.DEFAULT = 0;
MotionBlurPass.VELOCITY = 1;
MotionBlurPass.GEOMETRY = 2;